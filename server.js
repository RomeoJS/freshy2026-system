const express = require('express');
const mysql = require('mysql2/promise');
const cors = require('cors');
const path = require('path');
const excelJS = require('exceljs');
const multer = require('multer');
const fs = require('fs');

const app = express();
const port = 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use('/public', express.static(path.join(__dirname, 'public')));
app.get('/favicon.ico', (req, res) => res.sendFile(path.join(__dirname, 'public/images/logo.png')));
app.get('/live-popular', (req, res) => res.sendFile(path.join(__dirname, 'public/live-popular.html')));
app.get('/tally', (req, res) => res.sendFile(path.join(__dirname, 'public/tally.html')));

const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 25 * 1024 * 1024 }
});

const dbConfig = {
    host: process.env.DB_HOST || 'localhost',
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '123456', 
    database: process.env.DB_NAME || 'rmutk_freshy_2026',
    port: parseInt(process.env.DB_PORT || '3306'),
    ssl: process.env.DB_HOST ? { rejectUnauthorized: false } : false
};

const pool = mysql.createPool({
    ...dbConfig,
    waitForConnections: true,
    connectionLimit: 20,
    queueLimit: 0
});

const CATEGORIES = {
    miss: 'Miss',
    mister: 'Mister',
    queen: 'Miss Queen',
    congeniality: 'Miss Congeniality',
    jumbo: 'Miss Jumbo'
};

const ROUNDS_PRE = ['blackroom', 'grand', 'popular'];

async function initDB() {
    // 1. ลองเชื่อมต่อเพื่อ CREATE DATABASE หากเป็นไปได้ (เช่นบน localhost)
    try {
        const rootConn = await mysql.createConnection({
            host: dbConfig.host,
            user: dbConfig.user,
            password: dbConfig.password,
            port: dbConfig.port,
            ssl: dbConfig.ssl
        });
        await rootConn.execute(`CREATE DATABASE IF NOT EXISTS \`${dbConfig.database}\``);
        await rootConn.end();
    } catch (e) {
        // บน Cloud Database (TiDB / Aiven / Render) database มักถูกสร้างไว้แล้ว หรือผู้ใช้ไม่มีสิทธิ์ root CREATE DATABASE
        console.log('ℹ️ Note on CREATE DATABASE (safe to ignore on cloud):', e.message);
    }

    // 2. เชื่อมต่อผ่าน Connection Pool โดยตรง เพื่อสร้างตารางและ Migration คอลัมน์ที่จำเป็น
    try {
        const connection = await pool.getConnection();
        try {
            await connection.execute(`
                CREATE TABLE IF NOT EXISTS contestants (
                    id VARCHAR(20) PRIMARY KEY,
                    name VARCHAR(100) NOT NULL,
                    nickname VARCHAR(50) DEFAULT '',
                    category VARCHAR(50) NOT NULL,
                    faculty VARCHAR(150) DEFAULT '',
                    image VARCHAR(255) DEFAULT 'default.jpg',
                    image_data LONGBLOB NULL,
                    image_type VARCHAR(50) DEFAULT 'image/jpeg',
                    status VARCHAR(20) DEFAULT 'active'
                )
            `);

            // Helper function ในการเพิ่มคอลัมน์ใหม่อย่างปลอดภัย (ข้ามได้ถ้ามีอยู่แล้ว)
            const safeAddColumn = async (table, colDef) => {
                try {
                    await connection.execute(`ALTER TABLE ${table} ADD COLUMN ${colDef}`);
                    console.log(`✅ Added column to ${table}: ${colDef}`);
                } catch (colErr) {
                    if (!colErr.message.includes('Duplicate column') && !colErr.message.includes('already exists')) {
                        console.warn(`⚠️ Migration note for ${table}:`, colErr.message);
                    }
                }
            };

            await safeAddColumn('contestants', "image_data LONGBLOB NULL");
            await safeAddColumn('contestants', "image_type VARCHAR(50) DEFAULT 'image/jpeg'");
            await safeAddColumn('contestants', "faculty VARCHAR(150) DEFAULT ''");
            await safeAddColumn('contestants', "nickname VARCHAR(50) DEFAULT ''");
            await safeAddColumn('contestants', "status VARCHAR(20) DEFAULT 'active'");

            const [scoreCols] = await connection.execute(`
                SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS 
                WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'scores'
            `);
            const colNames = scoreCols.map(c => c.COLUMN_NAME);

            if (colNames.length === 0) {
                await connection.execute(`
                    CREATE TABLE scores (
                        judge_id VARCHAR(20) NOT NULL,
                        contestant_id VARCHAR(20) NOT NULL,
                        round_id VARCHAR(30) NOT NULL,
                        score_c1 INT DEFAULT 0,
                        score_c2 INT DEFAULT 0,
                        score_c3 INT DEFAULT 0,
                        score_c4 INT DEFAULT 0,
                        score_c5 INT DEFAULT 0,
                        score_c6 INT DEFAULT 0,
                        total_score INT DEFAULT 0,
                        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                        PRIMARY KEY (judge_id, contestant_id, round_id)
                    )
                `);
            } else {
                await safeAddColumn('scores', "round_id VARCHAR(30) NOT NULL DEFAULT 'blackroom'");
                await safeAddColumn('scores', "score_c4 INT DEFAULT 0");
                await safeAddColumn('scores', "score_c5 INT DEFAULT 0");
                await safeAddColumn('scores', "score_c6 INT DEFAULT 0");
            }

            await connection.execute(`
                CREATE TABLE IF NOT EXISTS sessions (
                    role VARCHAR(50) NOT NULL,
                    token VARCHAR(100) NOT NULL,
                    last_seen BIGINT NOT NULL,
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    PRIMARY KEY (role, token)
                )
            `);

            await connection.execute(`DROP TABLE IF EXISTS top5_finalists`);
            await connection.execute(`
                CREATE TABLE IF NOT EXISTS top5_finalists (
                    contestant_id VARCHAR(20) PRIMARY KEY,
                    category VARCHAR(50) NOT NULL,
                    pre_score INT DEFAULT 0,
                    speed_score INT DEFAULT 0,
                    qa_score INT DEFAULT 0,
                    avg_score DECIMAL(6,2) DEFAULT 0.00,
                    final_rank INT DEFAULT 0,
                    award VARCHAR(100) DEFAULT ''
                )
            `);

            // ย้ายคะแนนทั้งหมดของ Miss Congeniality ที่อาจเคยบันทึกค้างใน round_id='blackroom' ไปเก็บแยกที่ round_id='congeniality'
            try {
                await connection.execute(`
                    INSERT IGNORE INTO scores (judge_id, contestant_id, round_id, score_c1, score_c2, score_c3, score_c4, score_c5, score_c6, total_score, updated_at)
                    SELECT s.judge_id, s.contestant_id, 'congeniality', s.score_c1, s.score_c2, s.score_c3, s.score_c4, s.score_c5, s.score_c6, s.total_score, s.updated_at
                    FROM scores s
                    INNER JOIN contestants c ON c.id = s.contestant_id
                    WHERE c.category = 'congeniality'
                      AND s.round_id = 'blackroom'
                `);
                await connection.execute(`
                    DELETE s FROM scores s
                    INNER JOIN contestants c ON c.id = s.contestant_id
                    WHERE c.category = 'congeniality'
                      AND s.round_id = 'blackroom'
                `);
            } catch (migErr) {
                console.warn('⚠️ Miss Con legacy score cleanup note:', migErr.message);
            }
        } finally {
            connection.release();
        }
    } catch (error) {
        console.error('❌ DB Init Error:', error.message);
    }
}
initDB();

const USERS = { 
    'admin': 'admin2026', 
    'admin2': 'admin2026', 
    'judge1': '1111', 
    'judge2': '2222', 
    'judge3': '3333', 
    'judge4': '4444', 
    'judge5': '5555' 
};
const SESSION_TIMEOUT = 24 * 60 * 60 * 1000;
const activeSessions = {};
const adminSessions = {};

setInterval(async () => {
    const now = Date.now();
    for (const role in activeSessions) {
        if (now - activeSessions[role].lastSeen > SESSION_TIMEOUT) delete activeSessions[role];
    }
    for (const token in adminSessions) {
        if (now - adminSessions[token].lastSeen > SESSION_TIMEOUT) delete adminSessions[token];
    }
    try {
        await pool.execute('DELETE FROM sessions WHERE ? - last_seen > ?', [now, SESSION_TIMEOUT]);
    } catch (e) {}
}, 60 * 60 * 1000);

app.post('/api/login', async (req, res) => {
    const { role, password } = req.body;
    const isValid = USERS[role] && (USERS[role] === password || (role === 'admin2' && password === 'admin2'));
    if (!isValid) {
        return res.json({ success: false, message: 'รหัสผ่านไม่ถูกต้อง' });
    }

    const token = Math.random().toString(36).substring(2, 15) + Date.now().toString(36);
    const now = Date.now();
    const isAdmin = (role === 'admin' || role === 'admin2');

    if (isAdmin) adminSessions[token] = { lastSeen: now, role };
    else activeSessions[role] = { token, lastSeen: now };

    try {
        if (!isAdmin) await pool.execute('DELETE FROM sessions WHERE role = ?', [role]);
        await pool.execute('INSERT INTO sessions (role, token, last_seen) VALUES (?, ?, ?)', [role, token, now]);
    } catch (e) {}
    res.json({ success: true, token, role });
});

app.post('/api/ping', async (req, res) => {
    const { role, token } = req.body;
    if (!role || !token) return res.json({ success: false, reason: 'missing_params' });

    const now = Date.now();
    const isAdmin = (role === 'admin' || role === 'admin2');
    if (isAdmin) {
        if (adminSessions[token]) {
            adminSessions[token].lastSeen = now;
            return res.json({ success: true });
        }
    } else {
        if (activeSessions[role]) {
            if (activeSessions[role].token === token) {
                activeSessions[role].lastSeen = now;
                return res.json({ success: true });
            } else return res.json({ success: false, reason: 'superseded' });
        }
    }

    try {
        const [rows] = await pool.execute('SELECT * FROM sessions WHERE role = ? AND token = ?', [role, token]);
        if (rows.length > 0) {
            if (now - Number(rows[0].last_seen) < SESSION_TIMEOUT) {
                if (isAdmin) adminSessions[token] = { lastSeen: now, role };
                else activeSessions[role] = { token, lastSeen: now };
                return res.json({ success: true });
            }
        }
    } catch (e) {}
    res.json({ success: false, reason: 'expired' });
});

app.post('/api/logout', async (req, res) => {
    const { role, token } = req.body;
    const isAdmin = (role === 'admin' || role === 'admin2');
    if (isAdmin) delete adminSessions[token];
    else if (activeSessions[role] && activeSessions[role].token === token) delete activeSessions[role];
    try {
        await pool.execute('DELETE FROM sessions WHERE role = ? AND token = ?', [role, token]);
    } catch (e) {}
    res.json({ success: true });
});

let contestantsCache = { data: null, timestamp: 0 };
const CONTESTANTS_CACHE_TTL = 30000; // 30 วินาที

app.get('/api/contestants', async (req, res) => {
    try {
        const now = Date.now();
        if (contestantsCache.data && now - contestantsCache.timestamp < CONTESTANTS_CACHE_TTL) {
            return res.json(contestantsCache.data);
        }
        let rows;
        try {
            [rows] = await pool.execute(
                `SELECT id, name, nickname, category, faculty, image, COALESCE(status, 'active') AS status, IF(image_data IS NOT NULL, 1, 0) AS has_image 
                 FROM contestants 
                 ORDER BY FIELD(category, 'miss', 'mister', 'queen', 'congeniality', 'jumbo'), CAST(SUBSTRING(id, 2) AS UNSIGNED), id ASC`
            );
        } catch (queryErr) {
            if (queryErr.message.includes("Unknown column 'status'")) {
                try { await pool.execute("ALTER TABLE contestants ADD COLUMN status VARCHAR(20) DEFAULT 'active'"); } catch (e) {}
                [rows] = await pool.execute(
                    `SELECT id, name, nickname, category, faculty, image, 'active' AS status, IF(image_data IS NOT NULL, 1, 0) AS has_image 
                     FROM contestants 
                     ORDER BY FIELD(category, 'miss', 'mister', 'queen', 'congeniality', 'jumbo'), CAST(SUBSTRING(id, 2) AS UNSIGNED), id ASC`
                );
            } else {
                throw queryErr;
            }
        }
        contestantsCache = { data: rows, timestamp: now };
        res.json(rows);
    } catch (error) {
        console.error('❌ Error fetching contestants:', error.message);
        res.status(500).json({ error: 'Failed to fetch contestants', details: error.message });
    }
});

// เปลี่ยนสถานะผู้เข้าประกวด (ปกติ / สละสิทธิ์)
app.post('/api/contestants/:id/status', async (req, res) => {
    try {
        const { id } = req.params;
        const { status } = req.body;
        const targetStatus = status === 'resigned' ? 'resigned' : 'active';
        try {
            await pool.execute('UPDATE contestants SET status = ? WHERE id = ?', [targetStatus, id]);
        } catch (updateErr) {
            if (updateErr.message.includes("Unknown column 'status'")) {
                try { await pool.execute("ALTER TABLE contestants ADD COLUMN status VARCHAR(20) DEFAULT 'active'"); } catch (e) {}
                await pool.execute('UPDATE contestants SET status = ? WHERE id = ?', [targetStatus, id]);
            } else {
                throw updateErr;
            }
        }
        contestantsCache.timestamp = 0;
        summaryCache.timestamp = 0;
        res.json({ success: true, message: `เปลี่ยนสถานะเป็น ${targetStatus === 'resigned' ? 'สละสิทธิ์' : 'ปกติ'} เรียบร้อย`, status: targetStatus });
    } catch (error) {
        console.error('Error updating status:', error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

// เพิ่ม / อัปเดตข้อมูลผู้เข้าประกวด
app.post('/api/contestants', upload.single('image'), async (req, res) => {
    try {
        const { id, name, nickname, category, faculty, status } = req.body;
        if (!id || !name || !category) {
            return res.status(400).json({ success: false, message: 'กรุณากรอกรหัส ชื่อ และหมวดหมู่' });
        }
        const cleanId = id.trim().toUpperCase();
        const cleanStatus = status === 'resigned' ? 'resigned' : 'active';

        const runSave = async () => {
            if (req.file && req.file.buffer) {
                await pool.execute(`
                    INSERT INTO contestants (id, name, nickname, category, faculty, image_data, image_type, status)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                    ON DUPLICATE KEY UPDATE 
                        name = VALUES(name),
                        nickname = VALUES(nickname),
                        category = VALUES(category),
                        faculty = VALUES(faculty),
                        image_data = VALUES(image_data),
                        image_type = VALUES(image_type),
                        status = VALUES(status)
                `, [cleanId, name, nickname || '', category, faculty || '', req.file.buffer, req.file.mimetype || 'image/jpeg', cleanStatus]);
            } else {
                await pool.execute(`
                    INSERT INTO contestants (id, name, nickname, category, faculty, status)
                    VALUES (?, ?, ?, ?, ?, ?)
                    ON DUPLICATE KEY UPDATE 
                        name = VALUES(name),
                        nickname = VALUES(nickname),
                        category = VALUES(category),
                        faculty = VALUES(faculty),
                        status = VALUES(status)
                `, [cleanId, name, nickname || '', category, faculty || '', cleanStatus]);
            }
        };

        try {
            await runSave();
        } catch (saveErr) {
            if (saveErr.message.includes("Unknown column 'status'")) {
                try { await pool.execute("ALTER TABLE contestants ADD COLUMN status VARCHAR(20) DEFAULT 'active'"); } catch (e) {}
                await runSave();
            } else {
                throw saveErr;
            }
        }

        contestantsCache.timestamp = 0;
        contestantImageCache.delete(cleanId);
        summaryCache.timestamp = 0;
        res.json({ success: true, message: 'บันทึกข้อมูลผู้เข้าประกวดสำเร็จ' });
    } catch (error) {
        console.error('Error saving contestant:', error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

// Cache รูปผู้เข้าประกวดและรูป SVG ตัวแทนในหน่วยความจำ เพื่อป้องกัน request รัวไปยัง DB หรือเว็บภายนอก
const contestantImageCache = new Map();

function generateContestantSvg(id) {
    return `<svg xmlns="http://www.w3.org/2000/svg" width="400" height="500" viewBox="0 0 400 500">
  <defs>
    <linearGradient id="g" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#0a1254"/>
      <stop offset="100%" stop-color="#111FA2"/>
    </linearGradient>
  </defs>
  <rect width="100%" height="100%" fill="url(#g)"/>
  <circle cx="200" cy="180" r="65" fill="#5478FF" opacity="0.3"/>
  <circle cx="200" cy="165" r="35" fill="#FFDE42" opacity="0.85"/>
  <path d="M140 270 Q200 215 260 270" fill="none" stroke="#FFDE42" stroke-width="8" stroke-linecap="round" opacity="0.85"/>
  <text x="50%" y="350" dominant-baseline="middle" text-anchor="middle" fill="#FFDE42" font-family="'Segoe UI', Roboto, sans-serif" font-weight="900" font-size="36" letter-spacing="2">${id}</text>
  <text x="50%" y="390" dominant-baseline="middle" text-anchor="middle" fill="#5478FF" font-family="'Segoe UI', Roboto, sans-serif" font-weight="bold" font-size="14" letter-spacing="1">RMUTK FRESHY</text>
</svg>`;
}

app.get('/api/contestants/:id/image', async (req, res) => {
    try {
        const { id } = req.params;
        res.setHeader('Cache-Control', 'public, max-age=86400, stale-while-revalidate=604800');

        if (contestantImageCache.has(id)) {
            const cached = contestantImageCache.get(id);
            res.setHeader('Content-Type', cached.type);
            return res.send(cached.data);
        }

        const [rows] = await pool.execute('SELECT image_data, image_type, image FROM contestants WHERE id = ?', [id]);

        if (rows.length > 0 && rows[0].image_data) {
            const type = rows[0].image_type || 'image/jpeg';
            contestantImageCache.set(id, { type, data: rows[0].image_data });
            res.setHeader('Content-Type', type);
            return res.send(rows[0].image_data);
        }
        if (rows.length > 0 && rows[0].image && rows[0].image !== 'default.jpg') {
            const localFile = path.join(__dirname, 'public/images/contestants', rows[0].image);
            if (fs.existsSync(localFile)) {
                return res.sendFile(localFile);
            }
        }

        const svg = generateContestantSvg(id);
        contestantImageCache.set(id, { type: 'image/svg+xml; charset=utf-8', data: svg });
        res.setHeader('Content-Type', 'image/svg+xml; charset=utf-8');
        return res.send(svg);
    } catch (e) {
        const svg = generateContestantSvg(req.params.id || 'RMUTK');
        res.setHeader('Content-Type', 'image/svg+xml; charset=utf-8');
        res.setHeader('Cache-Control', 'public, max-age=86400');
        return res.send(svg);
    }
});

// Cache สำหรับคะแนนและผลสรุป
let scoresCache = { data: null, timestamp: 0 };
let summaryCache = { data: null, timestamp: 0 };
const CACHE_TTL = 15000; // 15 วินาที (หากไม่มีการบันทึกคะแนนใหม่ จะดึงจากแคชทันที)

app.get('/api/scores', async (req, res) => {
    try {
        const now = Date.now();
        if (scoresCache.data && now - scoresCache.timestamp < CACHE_TTL) {
            return res.json(scoresCache.data);
        }
        const [rows] = await pool.execute('SELECT * FROM scores');
        scoresCache = { data: rows, timestamp: now };
        res.json(rows);
    } catch (error) {
        res.status(500).json({ error: 'Failed to fetch scores' });
    }
});

app.get('/api/summary', async (req, res) => {
    try {
        const now = Date.now();
        if (summaryCache.data && now - summaryCache.timestamp < CACHE_TTL) {
            return res.json(summaryCache.data);
        }
        const summary = await calculateSummary();
        summaryCache = { data: summary, timestamp: now };
        res.json(summary);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// เมื่อมีการบันทึกคะแนน ให้เคลียร์ Cache ทันทีเพื่อให้ข้อมูลอัปเดต
app.post('/api/scores', async (req, res) => {
    const { judge_id, contestant_id, round_id, score_c1, score_c2, score_c3, score_c4, score_c5, score_c6 } = req.body;
    
    if (!judge_id || !contestant_id || !round_id) {
        return res.status(400).json({ success: false, message: 'ข้อมูลไม่ครบถ้วน' });
    }

    // ตรวจสอบสิทธิ์รอบ Popular Vote: กรรมการไม่มีสิทธิ์กรอกคะแนน ให้ได้เฉพาะแอดมินเท่านั้น (ไม่จำกัดเพดานคะแนน)
    if (round_id === 'popular') {
        if (judge_id !== 'admin' && judge_id !== 'admin2') {
            return res.status(403).json({ success: false, message: 'กรรมการไม่มีสิทธิ์กรอกคะแนน Popular Vote (เฉพาะแอดมินเท่านั้น)' });
        }
    }

    const c1 = Math.max(0, parseInt(score_c1) || 0);
    const c2 = Math.max(0, parseInt(score_c2) || 0);
    const c3 = Math.max(0, parseInt(score_c3) || 0);
    const c4 = Math.max(0, parseInt(score_c4) || 0);
    const c5 = Math.max(0, parseInt(score_c5) || 0);
    const c6 = Math.max(0, parseInt(score_c6) || 0);
    const total = (round_id === 'popular') ? c1 : (c1 + c2 + c3 + c4 + c5 + c6);

    try {
        const query = `
            INSERT INTO scores (judge_id, contestant_id, round_id, score_c1, score_c2, score_c3, score_c4, score_c5, score_c6, total_score) 
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON DUPLICATE KEY UPDATE 
                score_c1 = VALUES(score_c1),
                score_c2 = VALUES(score_c2),
                score_c3 = VALUES(score_c3),
                score_c4 = VALUES(score_c4),
                score_c5 = VALUES(score_c5),
                score_c6 = VALUES(score_c6),
                total_score = VALUES(total_score)
        `;
        await pool.execute(query, [judge_id, contestant_id, round_id, c1, c2, c3, c4, c5, c6, total]);
        
        // เคลียร์ Cache เพื่อให้ API ดึงข้อมูลใหม่
        scoresCache.timestamp = 0;
        summaryCache.timestamp = 0;
        
        res.json({ success: true, message: 'บันทึกคะแนนสำเร็จ', total_score: total });
    } catch (error) {
        console.error('❌ Error saving score:', error.message);
        res.status(500).json({ success: false, error: 'Failed to save score' });
    }
});

// API สำหรับทีมงานนับคะแนนหน้าร้าน/จุดนับคะแนน (Staff Quick-Tally Concurrency-Safe Increment)
app.post('/api/scores/increment', async (req, res) => {
    const { contestant_id, delta, staff_name, passcode } = req.body;
    
    // ตรวจสอบความถูกต้องของรหัสความปลอดภัย (Staff Passcode หรือ Admin Passcode)
    const validCodes = ['admin2026', '2026', 'freshy2026', USERS.admin];
    const pass = (passcode || '').trim();
    if (!validCodes.includes(pass)) {
        return res.status(403).json({ success: false, message: 'รหัสผ่านทีมงาน (Passcode) ไม่ถูกต้อง' });
    }

    if (!contestant_id) {
        return res.status(400).json({ success: false, message: 'กรุณาระบุหมายเลขผู้เข้าประกวด' });
    }

    const amount = parseInt(delta) || 0;
    if (amount === 0) {
        return res.status(400).json({ success: false, message: 'คะแนนที่เพิ่มหรือลดต้องไม่เป็น 0' });
    }

    try {
        const initialVal = Math.max(0, amount);
        const query = `
            INSERT INTO scores (judge_id, contestant_id, round_id, score_c1, total_score)
            VALUES ('admin', ?, 'popular', ?, ?)
            ON DUPLICATE KEY UPDATE
                score_c1 = GREATEST(0, score_c1 + ?),
                total_score = GREATEST(0, total_score + ?)
        `;
        await pool.execute(query, [contestant_id, initialVal, initialVal, amount, amount]);

        // เคลียร์แคช
        scoresCache.timestamp = 0;
        summaryCache.timestamp = 0;

        // ดึงคะแนนล่าสุดกลับไปตอบสนอง
        const [rows] = await pool.execute(
            `SELECT total_score FROM scores WHERE judge_id = 'admin' AND contestant_id = ? AND round_id = 'popular'`,
            [contestant_id]
        );
        const newTotal = rows[0] ? rows[0].total_score : initialVal;

        res.json({
            success: true,
            message: `อัปเดตคะแนน ${contestant_id} สำเร็จ (${amount > 0 ? '+' : ''}${amount})`,
            contestant_id,
            delta: amount,
            new_total: newTotal,
            staff_name: staff_name || 'Staff'
        });
    } catch (error) {
        console.error('❌ Error incrementing score:', error.message);
        res.status(500).json({ success: false, error: 'Failed to increment score' });
    }
});

async function calculateSummary() {
    let contestants;
    try {
        [contestants] = await pool.execute('SELECT id, name, nickname, faculty, category, image, COALESCE(status, \'active\') AS status FROM contestants');
    } catch (err) {
        if (err.message.includes("Unknown column 'status'")) {
            try { await pool.execute("ALTER TABLE contestants ADD COLUMN status VARCHAR(20) DEFAULT 'active'"); } catch (e) {}
            [contestants] = await pool.execute('SELECT id, name, nickname, faculty, category, image, \'active\' AS status FROM contestants');
        } else {
            throw err;
        }
    }
    const [scores] = await pool.execute('SELECT * FROM scores');

    const judges = ['judge1', 'judge2', 'judge3', 'judge4', 'judge5'];
    const conTalentJudges = ['judge1', 'judge2', 'judge3'];
    const categoriesData = {};

    for (const [catKey, catName] of Object.entries(CATEGORIES)) {
        if (catKey === 'congeniality') continue; // Miss Con แยกเฉพาะรอบความสามารถพิเศษ ไม่นำมารวมในรอบคัดเลือกวันจริง
        const catContestants = contestants.filter(c => c.category === catKey);
        const list = catContestants.map(c => {
            const contestantScores = scores.filter(s => s.contestant_id === c.id);
            const rounds = {};
            let preTotal = 0;

            // 1. รอบห้องดำ (5 กรรมการ รวมเต็ม 125)
            rounds.blackroom = { judges: {}, total: 0 };
            judges.forEach(jId => {
                const rec = contestantScores.find(s => s.judge_id === jId && s.round_id === 'blackroom');
                const score = rec ? rec.total_score : 0;
                rounds.blackroom.judges[jId] = score;
                rounds.blackroom.total += score;
                preTotal += score;
            });

            // 2. รอบ Grand Opening (5 กรรมการ รวมเต็ม 250)
            rounds.grand = { judges: {}, total: 0 };
            judges.forEach(jId => {
                const rec = contestantScores.find(s => s.judge_id === jId && s.round_id === 'grand');
                const score = rec ? rec.total_score : 0;
                rounds.grand.judges[jId] = score;
                rounds.grand.total += score;
                preTotal += score;
            });

            // 3. รอบ Popular Vote (แอดมินกรอกคนเดียว ไม่จำกัดคะแนน กรรมการไม่มีสิทธิ์กรอก)
            const popRec = contestantScores.find(s => s.round_id === 'popular' && (s.judge_id === 'admin' || s.judge_id === 'admin2')) ||
                           contestantScores.find(s => s.round_id === 'popular');
            const popScore = popRec ? (popRec.total_score || 0) : 0;
            rounds.popular = { judges: { admin: popScore }, total: popScore, score: popScore };
            preTotal += popScore;

            return {
                id: c.id,
                name: c.name,
                nickname: c.nickname || '',
                faculty: c.faculty || '',
                category: c.category,
                categoryName: catName,
                status: c.status || 'active',
                image: c.image || 'default.jpg',
                rounds,
                preTotal
            };
        });
        list.sort((a, b) => {
            if (b.preTotal !== a.preTotal) return b.preTotal - a.preTotal;
            const numA = parseInt((a.id || '').replace(/\D/g, '')) || 0;
            const numB = parseInt((b.id || '').replace(/\D/g, '')) || 0;
            if (numA !== numB) return numA - numB;
            return (a.id || '').localeCompare(b.id || '');
        });
        categoriesData[catKey] = list;
    }

    // แยกผลคะแนนรอบความสามารถพิเศษของ Miss Congeniality (เกณฑ์ 5 ข้อ เต็ม 100 • กรรมการ 3 ท่าน ก.1–ก.3) ออกต่างหาก ไม่ปนกับ TOP 5 / TOP 3
    const missConTalent = contestants
        .filter(c => c.category === 'congeniality')
        .map(c => {
            const contestantScores = scores.filter(s => s.contestant_id === c.id);
            const talentJudges = {};
            let total = 0;
            conTalentJudges.forEach(jId => {
                const rec = contestantScores.find(s => s.judge_id === jId && s.round_id === 'congeniality');
                const score = rec ? rec.total_score : 0;
                talentJudges[jId] = rec ? score : null;
                total += score;
            });
            return {
                id: c.id,
                name: c.name,
                nickname: c.nickname || '',
                faculty: c.faculty || '',
                category: c.category,
                categoryName: CATEGORIES.congeniality,
                status: c.status || 'active',
                image: c.image || 'default.jpg',
                judges: talentJudges,
                total,
                avg: Number((total / 3).toFixed(2))
            };
        })
        .sort((a, b) => {
            if (b.total !== a.total) return b.total - a.total;
            const numA = parseInt((a.id || '').replace(/\D/g, '')) || 0;
            const numB = parseInt((b.id || '').replace(/\D/g, '')) || 0;
            if (numA !== numB) return numA - numB;
            return (a.id || '').localeCompare(b.id || '');
        });

    const allCalculatedContestants = [];
    for (const [catKey, catList] of Object.entries(categoriesData)) {
        allCalculatedContestants.push(...catList);
    }
    allCalculatedContestants.sort((a, b) => b.preTotal - a.preTotal);

    // ผู้เข้าประกวดที่สละสิทธิ์ (status === 'resigned') จะไม่ได้รับคัดเลือกเข้าสู่รอบ TOP 5
    const eligibleForTop5 = allCalculatedContestants.filter(c => c.status !== 'resigned');
    const top5Selected = eligibleForTop5.slice(0, 5);

    const top5Finalists = top5Selected.map(finalist => {
        const contestantScores = scores.filter(s => s.contestant_id === finalist.id);
        const speedJudges = {};
        let speedTotal = 0;
        judges.forEach(jId => {
            const rec = contestantScores.find(s => s.judge_id === jId && s.round_id === 'speed');
            const score = rec ? rec.total_score : 0;
            speedJudges[jId] = score;
            speedTotal += score;
        });
        return { ...finalist, speedJudges, speedTotal };
    });

    top5Finalists.sort((a, b) => b.speedTotal !== a.speedTotal ? b.speedTotal - a.speedTotal : b.preTotal - a.preTotal);
    top5Finalists.forEach((f, idx) => { f.speedRank = idx + 1; f.isTop3 = idx < 3; });

    // ผู้เข้าประกวดที่สละสิทธิ์จะไม่ได้รับคัดเลือกเข้าสู่รอบ TOP 3
    const eligibleForTop3 = top5Finalists.filter(f => f.status !== 'resigned');
    const top3Selected = eligibleForTop3.slice(0, 3);
    const top3Finalists = top3Selected.map(finalist => {
        const contestantScores = scores.filter(s => s.contestant_id === finalist.id);
        const qaJudges = {};
        let qaTotal = 0;
        judges.forEach(jId => {
            const rec = contestantScores.find(s => s.judge_id === jId && s.round_id === 'qa');
            const score = rec ? rec.total_score : 0;
            qaJudges[jId] = score;
            qaTotal += score;
        });
        const avgScore = Number((qaTotal / 5).toFixed(2));
        return { ...finalist, qaJudges, qaTotal, avgScore };
    });

    top3Finalists.sort((a, b) => b.avgScore !== a.avgScore ? b.avgScore - a.avgScore : b.speedTotal - a.speedTotal);
    const awardTitles = ['👑 ชนะเลิศ THE WINNER FRESHY 2026', '🥈 รองชนะเลิศอันดับ 1', '🥉 รองชนะเลิศอันดับ 2'];
    top3Finalists.forEach((f, idx) => { f.finalRank = idx + 1; f.award = awardTitles[idx]; });

    const remainingTwo = top5Finalists.slice(3, 5);
    remainingTwo.forEach((f, idx) => {
        f.finalRank = idx + 4;
        f.qaJudges = {};
        f.qaTotal = 0;
        f.avgScore = 0;
        f.award = idx === 0 ? 'รองชนะเลิศอันดับ 3' : 'รองชนะเลิศอันดับ 4';
    });

    return {
        categories: categoriesData,
        top5: top5Finalists,
        top3: top3Finalists,
        finalRankings: [...top3Finalists, ...remainingTwo],
        missConTalent
    };
}

app.get('/api/export', async (req, res) => {
    res.status(500).send('API Export is simplified in this version.');
});

process.on('uncaughtException', (err) => console.error('⚠️ Uncaught Exception:', err.message));
process.on('unhandledRejection', (reason) => console.error('⚠️ Unhandled Rejection:', reason));

app.listen(port, () => console.log(`🚀 Server RMUTK FRESHY 2026 is running on port ${port}!`));