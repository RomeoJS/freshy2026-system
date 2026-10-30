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

// ตั้งค่า Multer สำหรับอัปโหลดรูปภาพ (เก็บใน Memory เพื่อบันทึกลง MySQL Database โดยตรง)
const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 25 * 1024 * 1024 } // รองรับรูปภาพขนาดสูงสุด 25MB
});

// ==========================================
// 1. ตั้งค่าฐานข้อมูล MySQL
// ==========================================
const dbConfig = {
    host: process.env.DB_HOST || 'localhost',
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '123456', 
    database: process.env.DB_NAME || 'rmutk_freshy_2026',
    port: parseInt(process.env.DB_PORT || '3306'),
    ssl: process.env.DB_HOST ? { rejectUnauthorized: false } : false
};

const CATEGORIES = {
    mister: 'Mister',
    miss: 'Miss',
    queen: 'Miss Queen',
    congeniality: 'Miss Congeniality',
    jumbo: 'Miss Jumbo'
};

const ROUNDS_PRE = ['blackroom', 'grand'];
const ROUNDS_ALL = ['blackroom', 'grand', 'speed', 'qa'];

async function initDB() {
    try {
        const rootConn = await mysql.createConnection({
            host: dbConfig.host,
            user: dbConfig.user,
            password: dbConfig.password,
            port: dbConfig.port
        });
        await rootConn.execute(`CREATE DATABASE IF NOT EXISTS \`${dbConfig.database}\``);
        await rootConn.end();

        const connection = await mysql.createConnection(dbConfig);
        
        // ตาราง 1: ผู้เข้าประกวด
        await connection.execute(`
            CREATE TABLE IF NOT EXISTS contestants (
                id VARCHAR(20) PRIMARY KEY,
                name VARCHAR(100) NOT NULL,
                category VARCHAR(50) NOT NULL,
                image VARCHAR(255) DEFAULT 'default.jpg',
                image_data LONGBLOB NULL,
                image_type VARCHAR(50) DEFAULT 'image/jpeg'
            )
        `);

        // ตรวจสอบคอลัมน์ image_data และ image_type เผื่อกรณีสร้างตารางไว้ก่อนหน้า
        const [contestantCols] = await connection.execute(`
            SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS 
            WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'contestants'
        `);
        const cColNames = contestantCols.map(c => c.COLUMN_NAME);
        if (!cColNames.includes('image_data')) {
            await connection.execute('ALTER TABLE contestants ADD COLUMN image_data LONGBLOB NULL');
        }
        if (!cColNames.includes('image_type')) {
            await connection.execute("ALTER TABLE contestants ADD COLUMN image_type VARCHAR(50) DEFAULT 'image/jpeg'");
        }

        // ตรวจสอบและซิงค์รูปภาพจากโฟลเดอร์ public/images/contestants ลง MySQL หากยังไม่มีใน DB
        try {
            const [needImgRows] = await connection.execute('SELECT id, image FROM contestants WHERE image_data IS NULL');
            const contestantsImgDir = path.join(__dirname, 'public/images/contestants');
            if (fs.existsSync(contestantsImgDir) && needImgRows.length > 0) {
                for (const row of needImgRows) {
                    const checkFiles = [row.image, `${row.id}.jpg`, `${row.id}.jpeg`, `${row.id}.png`, `${row.id}.webp`].filter(Boolean);
                    for (const f of checkFiles) {
                        const fp = path.join(contestantsImgDir, f);
                        if (fs.existsSync(fp)) {
                            const buf = fs.readFileSync(fp);
                            const ext = path.extname(f).toLowerCase();
                            const mime = ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' : 'image/jpeg';
                            await connection.execute(
                                'UPDATE contestants SET image_data = ?, image_type = ?, image = ? WHERE id = ?',
                                [buf, mime, f, row.id]
                            );
                            console.log(`✅ Synced image from disk to DB: ${row.id} (${f})`);
                            break;
                        }
                    }
                }
            }
        } catch (e) {
            console.warn('⚠️ Auto-sync images notice:', e.message);
        }

        // ตรวจสอบโครงสร้างตาราง scores
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
            console.log('✅ Created scores table with 6 criteria columns.');
        } else {
            if (!colNames.includes('round_id')) {
                await connection.execute(`ALTER TABLE scores ADD COLUMN round_id VARCHAR(30) NOT NULL DEFAULT 'blackroom'`);
            }
            if (!colNames.includes('score_c4')) {
                await connection.execute(`ALTER TABLE scores ADD COLUMN score_c4 INT DEFAULT 0`);
            }
            if (!colNames.includes('score_c5')) {
                await connection.execute(`ALTER TABLE scores ADD COLUMN score_c5 INT DEFAULT 0`);
            }
            if (!colNames.includes('score_c6')) {
                await connection.execute(`ALTER TABLE scores ADD COLUMN score_c6 INT DEFAULT 0`);
            }
            console.log('✅ scores table schema OK (all criteria columns exist).');
        }

        // ตาราง 3: sessions
        await connection.execute(`
            CREATE TABLE IF NOT EXISTS sessions (
                role VARCHAR(50) NOT NULL,
                token VARCHAR(100) NOT NULL,
                last_seen BIGINT NOT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                PRIMARY KEY (role, token)
            )
        `);

        // ตาราง 4: top5_finalists
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

        // ใส่ข้อมูลเริ่มต้น 29 คนหากตารางยังว่างอยู่
        const [existing] = await connection.execute('SELECT COUNT(*) as cnt FROM contestants');
        if (existing[0].cnt === 0) {
            const seedContestants = [
                // Mister (6 คน)
                ['M1', 'นาย พงศกร วรวิทย์ (มาร์ค)', 'mister', 'M1.jpg'],
                ['M2', 'นาย ธีรภัทร ศิริวัฒน์ (เจมส์)', 'mister', 'default.jpg'],
                ['M3', 'นาย ภานุวัฒน์ แสนดี (นนท์)', 'mister', 'default.jpg'],
                ['M4', 'นาย ชยพล สุขสมบูรณ์ (คิม)', 'mister', 'default.jpg'],
                ['M5', 'นาย กิตติศักดิ์ เจริญพร (โอ๊ก)', 'mister', 'default.jpg'],
                ['M6', 'นาย ธนกฤต วิริยะภาพ (กาย)', 'mister', 'default.jpg'],
                
                // Miss (6 คน)
                ['W1', 'น.ส. กัญญารัตน์ โสภณ (ฟ้า)', 'miss', 'W1.jpg'],
                ['W2', 'น.ส. ภัทรวดี ทรัพย์เจริญ (มายด์)', 'miss', 'default.jpg'],
                ['W3', 'น.ส. วรรณิดา แสงประเสริฐ (พลอย)', 'miss', 'default.jpg'],
                ['W4', 'น.ส. ชญาภา จิตต์จำนงค์ (เบลล์)', 'miss', 'default.jpg'],
                ['W5', 'น.ส. นภัสสร สุวรรณเมธี (เนย)', 'miss', 'default.jpg'],
                ['W6', 'น.ส. อลิสา พิชิตชัย (แอน)', 'miss', 'default.jpg'],

                // Miss Queen (6 คน)
                ['Q1', 'นาย ศุภชัย วิทยานุกูล (ลูกแก้ว)', 'queen', 'default.jpg'],
                ['Q2', 'นาย พิชญะ วงศ์ษา (ปอย)', 'queen', 'default.jpg'],
                ['Q3', 'นาย นราธิป บุญลือ (นาเดีย)', 'queen', 'default.jpg'],
                ['Q4', 'นาย ณัฐดนัย สมจิตต์ (โยชิ)', 'queen', 'default.jpg'],
                ['Q5', 'นาย ธนาธิป กุลรัตน์ (โมจิ)', 'queen', 'default.jpg'],
                ['Q6', 'นาย วรเมธ ชัยประสิทธิ์ (มิลิน)', 'queen', 'default.jpg'],

                // Miss Congeniality (6 คน)
                ['C1', 'น.ส. สุพิชชา ธนวัฒน์ (มุก)', 'congeniality', 'default.jpg'],
                ['C2', 'น.ส. กานต์พิชชา รัตนกร (ครีม)', 'congeniality', 'default.jpg'],
                ['C3', 'น.ส. ปุณยวีร์ วงศ์แก้ว (วิว)', 'congeniality', 'default.jpg'],
                ['C4', 'น.ส. พิชญาภา เลิศวรพงศ์ (แพร)', 'congeniality', 'default.jpg'],
                ['C5', 'น.ส. รินรดา พงษ์ศิริ (จีน่า)', 'congeniality', 'default.jpg'],
                ['C6', 'น.ส. จิดาภา กิตติคุณ (พั้นช์)', 'congeniality', 'default.jpg'],

                // Miss Jumbo (5 คน)
                ['J1', 'น.ส. ศิริพร บุญมี (กระปุก)', 'jumbo', 'default.jpg'],
                ['J2', 'น.ส. ชลธิชา ทับทิม (โอปอ)', 'jumbo', 'default.jpg'],
                ['J3', 'น.ส. พิมพิกา อุ่นใจ (ลูกตาล)', 'jumbo', 'default.jpg'],
                ['J4', 'น.ส. นันทิดา โพธิ์ทอง (แก้ม)', 'jumbo', 'default.jpg'],
                ['J5', 'น.ส. สุดารัตน์ มิ่งขวัญ (เนย)', 'jumbo', 'default.jpg']
            ];

            for (const c of seedContestants) {
                await connection.execute(
                    'INSERT INTO contestants (id, name, category, image) VALUES (?, ?, ?, ?)',
                    c
                );
            }
            console.log('✅ Seeded 29 default contestants.');
        }

        await connection.end();
        console.log('✅ Database tables initialized.');
        generateAndSaveExcel().catch(e => console.warn('⚠️ Excel init skip:', e.message));
    } catch (error) {
        console.error('❌ DB Init Error:', error.message);
    }
}
initDB();

// ==========================================
// 2. ระบบรหัสผ่าน และ Session
// ==========================================
const USERS = { 'admin': 'admin2026', 'judge1': '1111', 'judge2': '2222', 'judge3': '3333', 'judge4': '4444', 'judge5': '5555' };
const SESSION_TIMEOUT = 24 * 60 * 60 * 1000; // 24 ชั่วโมง
const activeSessions = {}; // สำหรับ judge: { [role]: { token, lastSeen } }
const adminSessions = {};  // สำหรับ admin: { [token]: { lastSeen } }

// ล้าง session เก่าที่หมดอายุ (เกิน 24 ชั่วโมง) ทุก 1 ชั่วโมง
setInterval(async () => {
    const now = Date.now();
    for (const role in activeSessions) {
        if (now - activeSessions[role].lastSeen > SESSION_TIMEOUT) {
            delete activeSessions[role];
        }
    }
    for (const token in adminSessions) {
        if (now - adminSessions[token].lastSeen > SESSION_TIMEOUT) {
            delete adminSessions[token];
        }
    }
    try {
        const connection = await mysql.createConnection(dbConfig);
        await connection.execute('DELETE FROM sessions WHERE ? - last_seen > ?', [now, SESSION_TIMEOUT]);
        await connection.end();
    } catch (e) {}
}, 60 * 60 * 1000);

app.post('/api/login', async (req, res) => {
    const { role, password } = req.body;
    if (!USERS[role] || USERS[role] !== password) {
        return res.json({ success: false, message: 'รหัสผ่านไม่ถูกต้อง' });
    }

    const token = Math.random().toString(36).substring(2, 15) + Date.now().toString(36);
    const now = Date.now();

    if (role === 'admin') {
        adminSessions[token] = { lastSeen: now };
    } else {
        activeSessions[role] = { token, lastSeen: now };
    }

    // บันทึกลง MySQL เพื่อความทนทานต่อการรีสตาร์ทเซิร์ฟเวอร์
    try {
        const connection = await mysql.createConnection(dbConfig);
        if (role !== 'admin') {
            await connection.execute('DELETE FROM sessions WHERE role = ?', [role]);
        }
        await connection.execute(
            'INSERT INTO sessions (role, token, last_seen) VALUES (?, ?, ?)',
            [role, token, now]
        );
        await connection.end();
    } catch (e) {
        console.error('Session DB save error:', e.message);
    }

    res.json({ success: true, token, role });
});

app.post('/api/ping', async (req, res) => {
    const { role, token } = req.body;
    if (!role || !token) return res.json({ success: false, reason: 'missing_params' });

    const now = Date.now();

    // 1. ตรวจสอบใน Memory ก่อนเพื่อความรวดเร็ว
    if (role === 'admin') {
        if (adminSessions[token]) {
            adminSessions[token].lastSeen = now;
            return res.json({ success: true });
        }
    } else {
        if (activeSessions[role]) {
            if (activeSessions[role].token === token) {
                activeSessions[role].lastSeen = now;
                return res.json({ success: true });
            } else {
                return res.json({ success: false, reason: 'superseded' });
            }
        }
    }

    // 2. ถ้าใน Memory ไม่มี (เช่น เซิร์ฟเวอร์เพิ่ง restart) ให้ตรวจสอบจาก MySQL
    try {
        const connection = await mysql.createConnection(dbConfig);
        const [rows] = await connection.execute(
            'SELECT * FROM sessions WHERE role = ? AND token = ?',
            [role, token]
        );
        await connection.end();

        if (rows.length > 0) {
            const sess = rows[0];
            if (now - Number(sess.last_seen) < SESSION_TIMEOUT) {
                if (role === 'admin') {
                    adminSessions[token] = { lastSeen: now };
                } else {
                    activeSessions[role] = { token, lastSeen: now };
                }
                return res.json({ success: true });
            }
        }
    } catch (e) {
        console.error('Session DB ping check error:', e.message);
    }

    res.json({ success: false, reason: 'expired' });
});

app.post('/api/logout', async (req, res) => {
    const { role, token } = req.body;
    if (role === 'admin') {
        delete adminSessions[token];
    } else if (activeSessions[role] && activeSessions[role].token === token) {
        delete activeSessions[role];
    }

    try {
        const connection = await mysql.createConnection(dbConfig);
        await connection.execute('DELETE FROM sessions WHERE role = ? AND token = ?', [role, token]);
        await connection.end();
    } catch (e) {}

    res.json({ success: true });
});

// ==========================================
// ⚙️ DB Migration Endpoint (admin only, one-time use)
// ==========================================
app.post('/api/admin/migrate-scores', async (req, res) => {
    const { secret } = req.body;
    if (secret !== 'freshy2026-migrate') return res.status(403).json({ error: 'Forbidden' });
    try {
        const connection = await mysql.createConnection(dbConfig);
        await connection.execute(`DROP TABLE IF EXISTS scores`);
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
        await connection.end();
        console.log('✅ scores table migrated successfully via API.');
        res.json({ success: true, message: 'scores table recreated with 6 criteria columns' });
    } catch (error) {
        console.error('❌ Migration error:', error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

// ==========================================
// 3. API Contestants
// ==========================================
// ดึงข้อมูลผู้เข้าประกวด (ไม่ส่ง image_data binary ขนาดใหญ่ เพื่อความรวดเร็ว)
app.get('/api/contestants', async (req, res) => {
    try {
        const connection = await mysql.createConnection(dbConfig);
        const [rows] = await connection.execute(
            'SELECT id, name, category, image, IF(image_data IS NOT NULL, 1, 0) AS has_image FROM contestants ORDER BY id ASC'
        );
        await connection.end();
        res.json(rows);
    } catch (error) {
        res.status(500).json({ error: 'Failed to fetch contestants' });
    }
});

// ดึงรูปภาพของผู้เข้าประกวดจาก Database โดยตรง
app.get('/api/contestants/:id/image', async (req, res) => {
    try {
        const { id } = req.params;
        const connection = await mysql.createConnection(dbConfig);
        const [rows] = await connection.execute(
            'SELECT image_data, image_type, image FROM contestants WHERE id = ?', 
            [id]
        );
        await connection.end();

        if (rows.length > 0 && rows[0].image_data) {
            res.setHeader('Content-Type', rows[0].image_type || 'image/jpeg');
            res.setHeader('Cache-Control', 'public, max-age=300, stale-while-revalidate=600');
            return res.send(rows[0].image_data);
        }

        // หากไม่มีใน DB ตรวจสอบในโฟลเดอร์ public/images/contestants สำรอง
        if (rows.length > 0 && rows[0].image && rows[0].image !== 'default.jpg') {
            const localFile = path.join(__dirname, 'public/images/contestants', rows[0].image);
            if (fs.existsSync(localFile)) {
                return res.sendFile(localFile);
            }
        }

        // กรณีไม่มีรูป ให้ redirect ไปยัง placeholder
        res.redirect(`https://placehold.co/400x500/111FA2/FFDE42?text=${encodeURIComponent(id)}`);
    } catch (e) {
        res.redirect(`https://placehold.co/400x500/111FA2/FFDE42?text=${encodeURIComponent(req.params.id || 'RMUTK')}`);
    }
});

// Admin เพิ่มข้อมูลและอัปโหลดรูป (บันทึกรูปลงฐานข้อมูล MySQL โดยตรง)
app.post('/api/contestants', upload.single('image'), async (req, res) => {
    const { id, name, category } = req.body;
    const hasFile = req.file && req.file.buffer;
    const filename = hasFile ? (id + path.extname(req.file.originalname || '.jpg')) : 'default.jpg';
    const imageData = hasFile ? req.file.buffer : null;
    const imageType = hasFile ? (req.file.mimetype || 'image/jpeg') : 'image/jpeg';

    try {
        const connection = await mysql.createConnection(dbConfig);
        if (hasFile) {
            await connection.execute(
                `INSERT INTO contestants (id, name, category, image, image_data, image_type) 
                 VALUES (?, ?, ?, ?, ?, ?) 
                 ON DUPLICATE KEY UPDATE 
                    name = VALUES(name), 
                    category = VALUES(category), 
                    image = VALUES(image), 
                    image_data = VALUES(image_data), 
                    image_type = VALUES(image_type)`,
                [id, name, category, filename, imageData, imageType]
            );
        } else {
            await connection.execute(
                `INSERT INTO contestants (id, name, category, image) 
                 VALUES (?, ?, ?, ?) 
                 ON DUPLICATE KEY UPDATE 
                    name = VALUES(name), 
                    category = VALUES(category)`,
                [id, name, category, 'default.jpg']
            );
        }
        await connection.end();
        await generateAndSaveExcel();
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// ==========================================
// 4. API Scores & Summary
// ==========================================
app.get('/api/scores', async (req, res) => {
    try {
        const connection = await mysql.createConnection(dbConfig);
        const [rows] = await connection.execute('SELECT * FROM scores');
        await connection.end();
        res.json(rows);
    } catch (error) {
        res.status(500).json({ error: 'Failed to fetch scores' });
    }
});

// สรุปผลการคำนวณคะแนนทั้งหมด
app.get('/api/summary', async (req, res) => {
    try {
        const summary = await calculateSummary();
        res.json(summary);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

async function calculateSummary() {
    const connection = await mysql.createConnection(dbConfig);
    const [contestants] = await connection.execute('SELECT id, name, category, image FROM contestants');
    const [scores] = await connection.execute('SELECT * FROM scores');
    await connection.end();

    const judges = ['judge1', 'judge2', 'judge3', 'judge4', 'judge5'];
    const categoriesData = {};

    for (const [catKey, catName] of Object.entries(CATEGORIES)) {
        const catContestants = contestants.filter(c => c.category === catKey);
        const list = catContestants.map(c => {
            const contestantScores = scores.filter(s => s.contestant_id === c.id);
            
            const rounds = {};
            let preTotal = 0; // รวมรอบ blackroom + grand ทั้ง 5 กรรมการ

            ROUNDS_PRE.forEach(rId => {
                rounds[rId] = { judges: {}, total: 0 };
                judges.forEach(jId => {
                    const rec = contestantScores.find(s => s.judge_id === jId && s.round_id === rId);
                    const score = rec ? rec.total_score : 0;
                    rounds[rId].judges[jId] = score;
                    rounds[rId].total += score;
                    preTotal += score;
                });
            });

            // คะแนนรายกรรมการ 2 รอบแรกรวม
            const judgeTotalsPre = {};
            judges.forEach(jId => {
                let jSum = 0;
                ROUNDS_PRE.forEach(rId => {
                    jSum += (rounds[rId].judges[jId] || 0);
                });
                judgeTotalsPre[jId] = jSum;
            });

            return {
                id: c.id,
                name: c.name,
                category: c.category,
                categoryName: catName,
                image: c.image || 'default.jpg',
                rounds,
                judgeTotalsPre,
                preTotal
            };
        });

        // จัดอันดับในหมวดหมู่
        list.sort((a, b) => b.preTotal - a.preTotal);
        categoriesData[catKey] = list;
    }

    // 🌟 คัดหา TOP 5 จาก 2 รอบแรก (คะแนน 2 รอบแรกรวมสูงสุด 5 อันดับแรก)
    const allCalculatedContestants = [];
    for (const [catKey, catList] of Object.entries(categoriesData)) {
        allCalculatedContestants.push(...catList);
    }
    allCalculatedContestants.sort((a, b) => b.preTotal - a.preTotal);
    
    // เลือก 5 คนที่คะแนน 2 รอบแรกเยอะที่สุด
    const top5Selected = allCalculatedContestants.slice(0, 5);

    // คำนวณคะแนนรอบ Speed (เต็ม 50 คะแนนต่อกรรมการ รวม 250 คะแนน)
    const top5Finalists = [];
    for (const finalist of top5Selected) {
        const contestantScores = scores.filter(s => s.contestant_id === finalist.id);
        const speedJudges = {};
        let speedTotal = 0;
        judges.forEach(jId => {
            const rec = contestantScores.find(s => s.judge_id === jId && s.round_id === 'speed');
            const score = rec ? rec.total_score : 0;
            speedJudges[jId] = score;
            speedTotal += score;
        });

        top5Finalists.push({
            ...finalist,
            speedJudges,
            speedTotal
        });
    }

    // เรียงอันดับในรอบ Top 5 Speed เพื่อคัด 3 คน
    top5Finalists.sort((a, b) => {
        if (b.speedTotal !== a.speedTotal) return b.speedTotal - a.speedTotal;
        return b.preTotal - a.preTotal;
    });

    top5Finalists.forEach((f, idx) => {
        f.speedRank = idx + 1;
        f.isTop3 = idx < 3;
    });

    // 🌟 คัดหา TOP 3 เพื่อเข้าสู่รอบตอบคำถามตัดสิน (ล้างคะแนนเดิม)
    const top3Selected = top5Finalists.slice(0, 3);
    const top3Finalists = [];

    for (const finalist of top3Selected) {
        const contestantScores = scores.filter(s => s.contestant_id === finalist.id);
        const qaJudges = {};
        let qaTotal = 0;
        judges.forEach(jId => {
            const rec = contestantScores.find(s => s.judge_id === jId && s.round_id === 'qa');
            const score = rec ? rec.total_score : 0;
            qaJudges[jId] = score;
            qaTotal += score;
        });

        // คิดคะแนนตัดสินจากรอบตอบคำถามล้วนๆ (ล้างคะแนนรอบ 5 คนเดิม)
        const avgScore = Number((qaTotal / 5).toFixed(2));

        top3Finalists.push({
            ...finalist,
            qaJudges,
            qaTotal,
            avgScore
        });
    }

    // จัดอันดับ 1 - 3
    top3Finalists.sort((a, b) => {
        if (b.avgScore !== a.avgScore) return b.avgScore - a.avgScore;
        return b.speedTotal - a.speedTotal;
    });

    const awardTitles = [
        '👑 ชนะเลิศ THE WINNER FRESHY 2026',
        '🥈 รองชนะเลิศอันดับ 1',
        '🥉 รองชนะเลิศอันดับ 2'
    ];

    top3Finalists.forEach((f, idx) => {
        f.finalRank = idx + 1;
        f.award = awardTitles[idx];
    });

    // Final 5 ทั้งหมด (Top 3 + อีก 2 คนที่ไม่ผ่านเข้า Top 3)
    const remainingTwo = top5Finalists.slice(3, 5);
    remainingTwo.forEach((f, idx) => {
        f.finalRank = idx + 4;
        f.qaJudges = {};
        f.qaTotal = 0;
        f.avgScore = 0;
        f.award = idx === 0 ? 'รองชนะเลิศอันดับ 3' : 'รองชนะเลิศอันดับ 4';
    });

    const finalRankings = [...top3Finalists, ...remainingTwo];

    return {
        categories: categoriesData,
        top5: top5Finalists,
        top3: top3Finalists,
        finalRankings
    };
}

// ==========================================
// 5. บันทึกคะแนน
// ==========================================
app.post('/api/scores', async (req, res) => {
    const { judge_id, contestant_id, round_id, score_c1, score_c2, score_c3, score_c4, score_c5, score_c6 } = req.body;
    
    if (!judge_id || !contestant_id || !round_id) {
        return res.status(400).json({ success: false, message: 'ข้อมูลไม่ครบถ้วน' });
    }

    const c1 = Math.max(0, parseInt(score_c1) || 0);
    const c2 = Math.max(0, parseInt(score_c2) || 0);
    const c3 = Math.max(0, parseInt(score_c3) || 0);
    const c4 = Math.max(0, parseInt(score_c4) || 0);
    const c5 = Math.max(0, parseInt(score_c5) || 0);
    const c6 = Math.max(0, parseInt(score_c6) || 0);
    const total = c1 + c2 + c3 + c4 + c5 + c6;

    try {
        const connection = await mysql.createConnection(dbConfig);
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
        await connection.execute(query, [judge_id, contestant_id, round_id, c1, c2, c3, c4, c5, c6, total]);
        await connection.end();
        
        res.json({ success: true, message: 'บันทึกคะแนนสำเร็จ', total_score: total });
        generateAndSaveExcel().catch(e => console.error('⚠️ Excel gen error (non-critical):', e.message));
    } catch (error) {
        console.error('❌ Error saving score:', error.message, error.stack);
        res.status(500).json({ success: false, error: 'Failed to save score', detail: error.message });
    }
});

// ==========================================
// 6. ฟังก์ชันสร้างไฟล์ Excel และอัปเดตตาราง Top 5
// ==========================================
let isGeneratingExcel = false;
let pendingExcelRegen = false;

async function generateAndSaveExcel() {
    if (isGeneratingExcel) {
        pendingExcelRegen = true;
        return;
    }
    isGeneratingExcel = true;

    try {
        const summary = await calculateSummary();
        const connection = await mysql.createConnection(dbConfig);
        
        // อัปเดตตาราง top5_finalists
        await connection.execute('TRUNCATE TABLE top5_finalists');
        for (const f of (summary.finalRankings || [])) {
            await connection.execute(`
                INSERT INTO top5_finalists (contestant_id, category, pre_score, speed_score, qa_score, avg_score, final_rank, award)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            `, [f.id, f.category, f.preTotal || 0, f.speedTotal || 0, f.qaTotal || 0, f.avgScore || 0, f.finalRank || 0, f.award || '']);
        }
        await connection.end();

        const workbook = new excelJS.Workbook();
        workbook.creator = 'RMUTK FRESHY 2026';
        workbook.created = new Date();

        const top5Ids = new Set((summary.top5 || []).map(f => f.id));
        const top3Ids = new Set((summary.top3 || []).map(f => f.id));

        // 🌟 ชีตที่ 1 - 5: แต่ละหมวดหมู่การประกวด (รอบคัดเลือก 2 รอบแรก)
        for (const [catKey, catName] of Object.entries(CATEGORIES)) {
            const worksheet = workbook.addWorksheet(catName);
            
            worksheet.columns = [
                { header: 'รหัส', key: 'id', width: 8 },
                { header: 'ชื่อ-นามสกุล', key: 'name', width: 28 },
                { header: '1. ห้องดำ (รวม 5 ก. เต็ม 125)', key: 'blackroom', width: 26 },
                { header: '2. Grand Opening (รวม 5 ก. เต็ม 250)', key: 'grand', width: 28 },
                { header: 'คะแนนรวม 2 รอบแรก (เต็ม 375)', key: 'preTotal', width: 26 },
                { header: 'สถานะ TOP 5', key: 'status', width: 28 }
            ];

            const headerRow = worksheet.getRow(1);
            headerRow.font = { bold: true, color: { argb: 'FFFFFFFF' } };
            headerRow.fill = {
                type: 'pattern',
                pattern: 'solid',
                fgColor: { argb: 'FF111FA2' }
            };
            headerRow.alignment = { vertical: 'middle', horizontal: 'center' };

            const contestantsList = summary.categories[catKey] || [];
            contestantsList.forEach((c) => {
                const isTop5 = top5Ids.has(c.id) && c.preTotal > 0;
                const row = worksheet.addRow({
                    id: c.id,
                    name: c.name,
                    blackroom: c.rounds.blackroom?.total || 0,
                    grand: c.rounds.grand?.total || 0,
                    preTotal: c.preTotal,
                    status: isTop5 ? '⭐ ผ่านเข้ารอบ TOP 5 (Speed)' : '-'
                });

                if (isTop5) {
                    row.fill = {
                        type: 'pattern',
                        pattern: 'solid',
                        fgColor: { argb: 'FFFFF3CD' }
                    };
                    row.font = { bold: true };
                }
            });
        }

        // 🌟 ชีตที่ 6: ผลรอบ TOP 5 (Speed)
        const speedSheet = workbook.addWorksheet('⚡ ผลรอบ TOP 5 (Speed)');
        speedSheet.columns = [
            { header: 'อันดับ Speed', key: 'rank', width: 14 },
            { header: 'รหัส', key: 'id', width: 10 },
            { header: 'ชื่อ-นามสกุล', key: 'name', width: 28 },
            { header: 'หมวดหมู่', key: 'category', width: 18 },
            { header: 'คะแนน 2 รอบแรก (375)', key: 'pre', width: 22 },
            { header: 'Speed ก.1 (50)', key: 's1', width: 14 },
            { header: 'Speed ก.2 (50)', key: 's2', width: 14 },
            { header: 'Speed ก.3 (50)', key: 's3', width: 14 },
            { header: 'Speed ก.4 (50)', key: 's4', width: 14 },
            { header: 'Speed ก.5 (50)', key: 's5', width: 14 },
            { header: 'รวม Speed (250)', key: 'speed_total', width: 18 },
            { header: 'สถานะ TOP 3', key: 'status', width: 28 }
        ];

        const sHeader = speedSheet.getRow(1);
        sHeader.font = { bold: true, color: { argb: 'FFFFFFFF' } };
        sHeader.fill = {
            type: 'pattern',
            pattern: 'solid',
            fgColor: { argb: 'FF1E3A8A' }
        };
        sHeader.alignment = { vertical: 'middle', horizontal: 'center' };

        (summary.top5 || []).forEach((f, idx) => {
            const isTop3 = idx < 3 && f.speedTotal > 0;
            const row = speedSheet.addRow({
                rank: idx + 1,
                id: f.id,
                name: f.name,
                category: f.categoryName,
                pre: f.preTotal,
                s1: f.speedJudges?.judge1 || 0,
                s2: f.speedJudges?.judge2 || 0,
                s3: f.speedJudges?.judge3 || 0,
                s4: f.speedJudges?.judge4 || 0,
                s5: f.speedJudges?.judge5 || 0,
                speed_total: f.speedTotal,
                status: isTop3 ? '👑 ผ่านเข้ารอบ TOP 3 ตัดสิน' : (idx === 3 ? 'รองชนะเลิศอันดับ 3' : 'รองชนะเลิศอันดับ 4')
            });

            if (isTop3) {
                row.font = { bold: true };
                row.fill = {
                    type: 'pattern',
                    pattern: 'solid',
                    fgColor: { argb: 'FFE0E7FF' }
                };
            }
        });

        // 🌟 ชีตที่ 7: ผลการตัดสินชี้ขาดรอบชิงชนะเลิศ (Official Result)
        const finalSheet = workbook.addWorksheet('🏆 ผลการตัดสินชี้ขาด (Official)');
        finalSheet.columns = [
            { header: 'อันดับ', key: 'rank', width: 10 },
            { header: 'รหัส', key: 'id', width: 10 },
            { header: 'ชื่อ-นามสกุล', key: 'name', width: 28 },
            { header: 'หมวดหมู่', key: 'category', width: 18 },
            { header: 'ตอบคำถาม ก.1 (100)', key: 'j1', width: 18 },
            { header: 'ตอบคำถาม ก.2 (100)', key: 'j2', width: 18 },
            { header: 'ตอบคำถาม ก.3 (100)', key: 'j3', width: 18 },
            { header: 'ตอบคำถาม ก.4 (100)', key: 'j4', width: 18 },
            { header: 'ตอบคำถาม ก.5 (100)', key: 'j5', width: 18 },
            { header: 'รวมตอบคำถาม (500)', key: 'qa_total', width: 20 },
            { header: 'คะแนนเฉลี่ยสุทธิ (100)', key: 'avg', width: 22 },
            { header: 'รางวัลเกียรติยศ', key: 'award', width: 32 }
        ];

        const fHeader = finalSheet.getRow(1);
        fHeader.font = { bold: true, color: { argb: 'FF111FA2' } };
        fHeader.fill = {
            type: 'pattern',
            pattern: 'solid',
            fgColor: { argb: 'FFFFDE42' }
        };
        fHeader.alignment = { vertical: 'middle', horizontal: 'center' };

        (summary.finalRankings || []).forEach((f, idx) => {
            const isWinner = idx === 0;
            const isTop3 = idx < 3;
            const row = finalSheet.addRow({
                rank: f.finalRank || (idx + 1),
                id: f.id,
                name: f.name,
                category: f.categoryName,
                j1: isTop3 ? (f.qaJudges?.judge1 || 0) : '-',
                j2: isTop3 ? (f.qaJudges?.judge2 || 0) : '-',
                j3: isTop3 ? (f.qaJudges?.judge3 || 0) : '-',
                j4: isTop3 ? (f.qaJudges?.judge4 || 0) : '-',
                j5: isTop3 ? (f.qaJudges?.judge5 || 0) : '-',
                qa_total: isTop3 ? f.qaTotal : '-',
                avg: isTop3 ? f.avgScore : '-',
                award: f.award || '-'
            });

            if (isWinner) {
                row.font = { bold: true };
                row.fill = {
                    type: 'pattern',
                    pattern: 'solid',
                    fgColor: { argb: 'FFFFECC4' }
                };
            }
        });

        const filePath = path.join(__dirname, 'public', 'freshy2026_scores.xlsx');
        await workbook.xlsx.writeFile(filePath);
        console.log('📊 Auto Excel saved successfully.');
    } catch (error) {
        console.error('❌ Auto Excel Save Error:', error.message);
    } finally {
        isGeneratingExcel = false;
        if (pendingExcelRegen) {
            pendingExcelRegen = false;
            generateAndSaveExcel();
        }
    }
}

app.get('/api/export', (req, res) => {
    const filePath = path.join(__dirname, 'public', 'freshy2026_scores.xlsx');
    res.download(filePath, 'RMUTK_Freshy2026_Scores.xlsx');
});

process.on('uncaughtException', (err) => {
    console.error('⚠️ Uncaught Exception:', err.message);
});
process.on('unhandledRejection', (reason) => {
    console.error('⚠️ Unhandled Rejection:', reason);
});

app.listen(port, () => console.log(`🚀 Server RMUTK FRESHY 2026 is running on port ${port}!`));