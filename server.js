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

// ตั้งค่า Multer สำหรับอัปโหลดรูปภาพ
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        const dir = path.join(__dirname, 'public/images/contestants');
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        cb(null, dir);
    },
    filename: (req, file, cb) => {
        cb(null, req.body.id + path.extname(file.originalname));
    }
});
const upload = multer({ storage: storage });

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

const ROUNDS_29 = ['intro', 'grand', 'speech', 'theme'];

async function initDB() {
    try {
        // สร้าง Database หากยังไม่มี
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
                image VARCHAR(255) DEFAULT 'default.jpg'
            )
        `);

        // ตรวจสอบโครงสร้างตาราง scores — ใช้ DATABASE() เพื่อรองรับทุก environment
        const [scoreCols] = await connection.execute(`
            SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS 
            WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'scores' AND COLUMN_NAME = 'round_id'
        `);

        if (scoreCols.length === 0) {
            console.log('⚠️ scores table missing round_id column — recreating...');
            await connection.execute(`DROP TABLE IF EXISTS scores`);
            await connection.execute(`
                CREATE TABLE scores (
                    judge_id VARCHAR(20) NOT NULL,
                    contestant_id VARCHAR(20) NOT NULL,
                    round_id VARCHAR(30) NOT NULL,
                    score_c1 INT DEFAULT 0,
                    score_c2 INT DEFAULT 0,
                    score_c3 INT DEFAULT 0,
                    total_score INT DEFAULT 0,
                    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                    PRIMARY KEY (judge_id, contestant_id, round_id)
                )
            `);
            console.log('✅ Created new scores table schema with round_id.');
        } else {
            console.log('✅ scores table schema OK (round_id exists).');
        }

        // ตาราง 3: Top 5
        await connection.execute(`DROP TABLE IF EXISTS top5_finalists`);
        await connection.execute(`
            CREATE TABLE IF NOT EXISTS top5_finalists (
                contestant_id VARCHAR(20) PRIMARY KEY,
                category VARCHAR(50) NOT NULL,
                round29_score INT DEFAULT 0,
                qa_score INT DEFAULT 0,
                total_score INT DEFAULT 0,
                avg_score DECIMAL(6,2) DEFAULT 0.00
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
                ['J1', 'น.ส. ปิยะธิดา สุขสันต์ (ก้อย)', 'jumbo', 'default.jpg'],
                ['J2', 'น.ส. สุธิดา พูนทรัพย์ (บิว)', 'jumbo', 'default.jpg'],
                ['J3', 'น.ส. อังคณา มีชัย (ไอซ์)', 'jumbo', 'default.jpg'],
                ['J4', 'น.ส. พิมพิกา อัครเดช (หมวย)', 'jumbo', 'default.jpg'],
                ['J5', 'น.ส. วรัญญา สิริโภคา (น้ำหวาน)', 'jumbo', 'default.jpg']
            ];

            for (const c of seedContestants) {
                await connection.execute(
                    'INSERT INTO contestants (id, name, category, image) VALUES (?, ?, ?, ?)',
                    c
                );
            }
            console.log('✅ Seeded 29 default contestants across 5 categories.');
        }

        await connection.end();
        console.log('✅ Database tables initialized (3 Tables).');
        // Fire-and-forget Excel gen (ไม่ block startup บน cloud)
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
const activeSessions = {}; 

setInterval(() => {
    const now = Date.now();
    for (const role in activeSessions) {
        if (now - activeSessions[role].lastSeen > 15000) delete activeSessions[role];
    }
}, 10000);

app.post('/api/login', (req, res) => {
    const { role, password } = req.body;
    if (!USERS[role] || USERS[role] !== password) return res.json({ success: false, message: 'รหัสผ่านไม่ถูกต้อง' });
    if (activeSessions[role] && (Date.now() - activeSessions[role].lastSeen < 15000)) return res.json({ success: false, message: 'บัญชีนี้กำลังถูกใช้งานอยู่ในเครื่องอื่น!' });

    const token = Math.random().toString(36).substring(2, 15);
    activeSessions[role] = { token, lastSeen: Date.now() };
    res.json({ success: true, token, role });
});

app.post('/api/ping', (req, res) => {
    const { role, token } = req.body;
    if (activeSessions[role] && activeSessions[role].token === token) {
        activeSessions[role].lastSeen = Date.now();
        return res.json({ success: true });
    }
    res.json({ success: false });
});

app.post('/api/logout', (req, res) => {
    const { role, token } = req.body;
    if (activeSessions[role] && activeSessions[role].token === token) delete activeSessions[role];
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
        // ตรวจสอบ columns ปัจจุบัน
        const [cols] = await connection.execute(`SHOW COLUMNS FROM scores`).catch(() => [[]]);
        console.log('Current scores columns:', cols.map(c => c.Field));
        
        await connection.execute(`DROP TABLE IF EXISTS scores`);
        await connection.execute(`
            CREATE TABLE scores (
                judge_id VARCHAR(20) NOT NULL,
                contestant_id VARCHAR(20) NOT NULL,
                round_id VARCHAR(30) NOT NULL,
                score_c1 INT DEFAULT 0,
                score_c2 INT DEFAULT 0,
                score_c3 INT DEFAULT 0,
                total_score INT DEFAULT 0,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                PRIMARY KEY (judge_id, contestant_id, round_id)
            )
        `);
        await connection.end();
        console.log('✅ scores table migrated successfully via API.');
        res.json({ success: true, message: 'scores table recreated with round_id column' });
    } catch (error) {
        console.error('❌ Migration error:', error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

// ==========================================
// 3. API Contestants
// ==========================================
app.get('/api/contestants', async (req, res) => {
    try {
        const connection = await mysql.createConnection(dbConfig);
        const [rows] = await connection.execute('SELECT * FROM contestants ORDER BY id ASC');
        await connection.end();
        res.json(rows);
    } catch (error) {
        res.status(500).json({ error: 'Failed to fetch contestants' });
    }
});

// Admin เพิ่มข้อมูลและอัปโหลดรูป
app.post('/api/contestants', upload.single('image'), async (req, res) => {
    const { id, name, category } = req.body;
    const image = req.file ? req.file.filename : 'default.jpg';
    try {
        const connection = await mysql.createConnection(dbConfig);
        await connection.execute(
            'INSERT INTO contestants (id, name, category, image) VALUES (?, ?, ?, ?) ON DUPLICATE KEY UPDATE name=?, category=?, image=IF(?!="default.jpg", ?, image)', 
            [id, name, category, image, name, category, image, image]
        );
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
    const [contestants] = await connection.execute('SELECT * FROM contestants');
    const [scores] = await connection.execute('SELECT * FROM scores');
    await connection.end();

    const judges = ['judge1', 'judge2', 'judge3', 'judge4', 'judge5'];
    const categoriesData = {};

    for (const [catKey, catName] of Object.entries(CATEGORIES)) {
        const catContestants = contestants.filter(c => c.category === catKey);
        const list = catContestants.map(c => {
            const contestantScores = scores.filter(s => s.contestant_id === c.id);
            
            // คะแนนรายรอบสำหรับกรรมการแต่ละท่าน
            const rounds = {};
            let round29Total = 0;

            ROUNDS_29.forEach(rId => {
                rounds[rId] = { judges: {}, total: 0 };
                judges.forEach(jId => {
                    const rec = contestantScores.find(s => s.judge_id === jId && s.round_id === rId);
                    const score = rec ? rec.total_score : 0;
                    rounds[rId].judges[jId] = score;
                    rounds[rId].total += score;
                    round29Total += score;
                });
            });

            // คะแนนรายกรรมการรอบ 29 คน
            const judgeTotals29 = {};
            judges.forEach(jId => {
                let jSum = 0;
                ROUNDS_29.forEach(rId => {
                    jSum += (rounds[rId].judges[jId] || 0);
                });
                judgeTotals29[jId] = jSum;
            });

            return {
                id: c.id,
                name: c.name,
                category: c.category,
                categoryName: catName,
                image: c.image || 'default.jpg',
                rounds,
                judgeTotals29,
                round29Total
            };
        });

        // จัดอันดับในหมวดหมู่เพื่อหาผู้ผ่านเข้ารอบ TOP 5
        list.sort((a, b) => b.round29Total - a.round29Total);
        categoriesData[catKey] = list;
    }

    // 🌟 ผู้ผ่านเข้ารอบ TOP 5: คัดจากผู้ที่มีคะแนนรอบ 29 คน สูงที่สุด 5 อันดับแรก (ไม่จำกัดหมวดหมู่)
    const allCalculatedContestants = [];
    for (const [catKey, catList] of Object.entries(categoriesData)) {
        allCalculatedContestants.push(...catList);
    }
    // เรียงคะแนนรอบ 29 คนจากมากไปน้อย
    allCalculatedContestants.sort((a, b) => b.round29Total - a.round29Total);
    
    // เลือก 5 คนที่คะแนนเยอะที่สุด
    const top5Selected = allCalculatedContestants.slice(0, 5);

    const top5Finalists = [];
    for (const finalist of top5Selected) {
        const contestantScores = scores.filter(s => s.contestant_id === finalist.id);
        
        // คะแนนรอบตอบคำถาม
        const qaJudges = {};
        let qaTotal = 0;
        judges.forEach(jId => {
            const rec = contestantScores.find(s => s.judge_id === jId && s.round_id === 'qa');
            const score = rec ? rec.total_score : 0;
            qaJudges[jId] = score;
            qaTotal += score;
        });

        // สูตร: เอาคะแนนรอบ 29 คน มารวมกับรอบตอบคำถาม แล้วหารจำนวนกรรมการคือ 5 คน
        const grandTotal = finalist.round29Total + qaTotal;
        const avgScore = Number((grandTotal / 5).toFixed(2));

        top5Finalists.push({
            ...finalist,
            qaJudges,
            qaTotal,
            grandTotal,
            avgScore
        });
    }

    // จัดอันดับ 1 - 5 ในรอบ Final
    top5Finalists.sort((a, b) => b.avgScore - a.avgScore);
    top5Finalists.forEach((f, idx) => {
        f.rank = idx + 1;
    });

    return {
        categories: categoriesData,
        top5: top5Finalists
    };
}

// ==========================================
// 5. บันทึกคะแนน
// ==========================================
app.post('/api/scores', async (req, res) => {
    const { judge_id, contestant_id, round_id, score_c1, score_c2, score_c3 } = req.body;
    
    if (!judge_id || !contestant_id || !round_id) {
        return res.status(400).json({ success: false, message: 'ข้อมูลไม่ครบถ้วน' });
    }

    const c1 = Math.max(0, parseInt(score_c1) || 0);
    const c2 = Math.max(0, parseInt(score_c2) || 0);
    const c3 = Math.max(0, parseInt(score_c3) || 0);
    const total = c1 + c2 + c3;

    try {
        const connection = await mysql.createConnection(dbConfig);
        const query = `
            INSERT INTO scores (judge_id, contestant_id, round_id, score_c1, score_c2, score_c3, total_score) 
            VALUES (?, ?, ?, ?, ?, ?, ?)
            ON DUPLICATE KEY UPDATE 
                score_c1 = VALUES(score_c1),
                score_c2 = VALUES(score_c2),
                score_c3 = VALUES(score_c3),
                total_score = VALUES(total_score)
        `;
        await connection.execute(query, [judge_id, contestant_id, round_id, c1, c2, c3, total]);
        await connection.end();
        
        // ✅ ตอบกลับทันทีหลังบันทึก DB สำเร็จ — ไม่รอ Excel (กัน timeout/filesystem error บน cloud)
        res.json({ success: true, message: 'บันทึกคะแนนสำเร็จ', total_score: total });

        // 🔥 สร้าง Excel แบบ background (fire-and-forget) ไม่ block response
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
        for (const f of summary.top5) {
            await connection.execute(`
                INSERT INTO top5_finalists (contestant_id, category, round29_score, qa_score, total_score, avg_score)
                VALUES (?, ?, ?, ?, ?, ?)
            `, [f.id, f.category, f.round29Total, f.qaTotal, f.grandTotal, f.avgScore]);
        }
        await connection.end();

        const workbook = new excelJS.Workbook();
        workbook.creator = 'RMUTK FRESHY 2026';
        workbook.created = new Date();

        const top5Ids = new Set(summary.top5.map(f => f.id));

        // 🌟 ชีตที่ 1 - 5: แต่ละหมวดหมู่การประกวด
        for (const [catKey, catName] of Object.entries(CATEGORIES)) {
            const worksheet = workbook.addWorksheet(catName);
            
            worksheet.columns = [
                { header: 'รหัส', key: 'id', width: 8 },
                { header: 'ชื่อ-นามสกุล', key: 'name', width: 28 },
                { header: 'แนะนำตัว (รวม 5 ก.)', key: 'intro', width: 20 },
                { header: 'Grand Opening (รวม 5 ก.)', key: 'grand', width: 22 },
                { header: 'Speech 1 min (รวม 5 ก.)', key: 'speech', width: 20 },
                { header: 'ชุดธีม (รวม 5 ก.)', key: 'theme', width: 18 },
                { header: 'คะแนนรวมรอบ 29 คน', key: 'total29', width: 20 },
                { header: 'สถานะ TOP 5', key: 'status', width: 25 }
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
                const isTop5 = top5Ids.has(c.id) && c.round29Total > 0;
                const row = worksheet.addRow({
                    id: c.id,
                    name: c.name,
                    intro: c.rounds.intro.total,
                    grand: c.rounds.grand.total,
                    speech: c.rounds.speech.total,
                    theme: c.rounds.theme.total,
                    total29: c.round29Total,
                    status: isTop5 ? '⭐ ผ่านเข้ารอบ 5 คนสุดท้าย (Top 5 คะแนนสูงสุด)' : '-'
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

        // 🌟 ชีตที่ 6: สรุปผลรอบ TOP 5 (ตอบคำถาม และคะแนนสุทธิ)
        const top5Sheet = workbook.addWorksheet('🏆 ผลการตัดสินรอบ TOP 5');
        top5Sheet.columns = [
            { header: 'อันดับ', key: 'rank', width: 10 },
            { header: 'รหัส', key: 'id', width: 10 },
            { header: 'ชื่อ-นามสกุล', key: 'name', width: 28 },
            { header: 'หมวดหมู่', key: 'category', width: 18 },
            { header: 'คะแนนรอบ 29 คน (รวม 5 ก.)', key: 'r29', width: 24 },
            { header: 'ตอบคำถาม ก.1', key: 'j1', width: 14 },
            { header: 'ตอบคำถาม ก.2', key: 'j2', width: 14 },
            { header: 'ตอบคำถาม ก.3', key: 'j3', width: 14 },
            { header: 'ตอบคำถาม ก.4', key: 'j4', width: 14 },
            { header: 'ตอบคำถาม ก.5', key: 'j5', width: 14 },
            { header: 'รวมตอบคำถาม', key: 'qa_total', width: 16 },
            { header: 'คะแนนรวมสุทธิ', key: 'grand', width: 18 },
            { header: 'คะแนนเฉลี่ยสุทธิ (หาร 5 กรรมการ)', key: 'avg', width: 28 },
            { header: 'รางวัล', key: 'award', width: 25 }
        ];

        const tHeader = top5Sheet.getRow(1);
        tHeader.font = { bold: true, color: { argb: 'FF111FA2' } };
        tHeader.fill = {
            type: 'pattern',
            pattern: 'solid',
            fgColor: { argb: 'FFFFDE42' }
        };
        tHeader.alignment = { vertical: 'middle', horizontal: 'center' };

        const awardTitles = [
            '👑 ชนะเลิศ THE WINNER FRESHY 2026',
            '🥈 รองชนะเลิศอันดับ 1',
            '🥉 รองชนะเลิศอันดับ 2',
            'รองชนะเลิศอันดับ 3',
            'รองชนะเลิศอันดับ 4'
        ];

        summary.top5.forEach((f, idx) => {
            const row = top5Sheet.addRow({
                rank: f.rank,
                id: f.id,
                name: f.name,
                category: f.categoryName,
                r29: f.round29Total,
                j1: f.qaJudges.judge1 || 0,
                j2: f.qaJudges.judge2 || 0,
                j3: f.qaJudges.judge3 || 0,
                j4: f.qaJudges.judge4 || 0,
                j5: f.qaJudges.judge5 || 0,
                qa_total: f.qaTotal,
                grand: f.grandTotal,
                avg: f.avgScore,
                award: awardTitles[idx] || '-'
            });

            if (idx === 0) {
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