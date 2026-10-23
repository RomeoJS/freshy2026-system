const express = require('express');
const mysql = require('mysql2/promise');
const cors = require('cors');
const path = require('path');
const excelJS = require('exceljs'); // เพิ่มไลบรารี Excel

const app = express();
const port = 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ==========================================
// 1. ตั้งค่าฐานข้อมูล MySQL
// ==========================================
const dbConfig = {
    host: process.env.DB_HOST || 'localhost',
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '123456', 
    database: process.env.DB_NAME || 'test',
    port: process.env.DB_PORT || 4000,
    ssl: process.env.DB_HOST ? { rejectUnauthorized: false } : false
};

// ==========================================
// สร้างตาราง contestants อัตโนมัติ (ถ้ายังไม่มี)
// ==========================================
async function initDB() {
    try {
        const connection = await mysql.createConnection(dbConfig);
        await connection.execute(`
            CREATE TABLE IF NOT EXISTS contestants (
                id VARCHAR(20) PRIMARY KEY,
                name VARCHAR(100) NOT NULL,
                category VARCHAR(50) NOT NULL,
                is_top5 BOOLEAN DEFAULT FALSE
            )
        `);
        // ตารางคะแนน (กรณีที่ยังไม่มี)
        await connection.execute(`
            CREATE TABLE IF NOT EXISTS scores (
                judge_id VARCHAR(20),
                contestant_id VARCHAR(20),
                score_intro INT DEFAULT 0,
                score_theme INT DEFAULT 0,
                score_speech INT DEFAULT 0,
                score_formal INT DEFAULT 0,
                score_qa INT DEFAULT 0,
                PRIMARY KEY (judge_id, contestant_id)
            )
        `);
        await connection.end();
        console.log('✅ Database tables checked/initialized.');
    } catch (error) {
        console.error('❌ DB Init Error:', error.message);
    }
}
initDB();

// ==========================================
// 2. ระบบรหัสผ่าน และจัดการเซสชัน (กันเข้าซ้อน)
// ==========================================
const USERS = {
    'admin': 'admin2026',
    'judge1': '1111',
    'judge2': '2222',
    'judge3': '3333',
    'judge4': '4444',
    'judge5': '5555'
};

const activeSessions = {}; 

setInterval(() => {
    const now = Date.now();
    for (const role in activeSessions) {
        if (now - activeSessions[role].lastSeen > 15000) {
            delete activeSessions[role];
        }
    }
}, 10000);

app.post('/api/login', (req, res) => {
    const { role, password } = req.body;
    
    if (!USERS[role] || USERS[role] !== password) {
        return res.json({ success: false, message: 'รหัสผ่านไม่ถูกต้อง' });
    }

    if (activeSessions[role] && (Date.now() - activeSessions[role].lastSeen < 15000)) {
        return res.json({ success: false, message: 'บัญชีนี้กำลังถูกใช้งานอยู่ในเครื่องอื่น!' });
    }

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
    res.json({ success: false, message: 'เซสชันหมดอายุ หรือมีคนล็อกอินซ้อน' });
});

app.post('/api/logout', (req, res) => {
    const { role, token } = req.body;
    if (activeSessions[role] && activeSessions[role].token === token) {
        delete activeSessions[role];
    }
    res.json({ success: true });
});

// ==========================================
// 3. API จัดการผู้เข้าประกวด (Contestants & Top 5)
// ==========================================

// ดึงผู้เข้าประกวดทั้งหมด
app.get('/api/contestants', async (req, res) => {
    try {
        const connection = await mysql.createConnection(dbConfig);
        const [rows] = await connection.execute('SELECT * FROM contestants');
        await connection.end();
        res.json(rows);
    } catch (error) {
        res.status(500).json({ error: 'Failed to fetch contestants' });
    }
});

// เพิ่มผู้เข้าประกวดใหม่
app.post('/api/contestants', async (req, res) => {
    const { id, name, category } = req.body;
    try {
        const connection = await mysql.createConnection(dbConfig);
        await connection.execute(
            'INSERT INTO contestants (id, name, category, is_top5) VALUES (?, ?, ?, false)', 
            [id, name, category]
        );
        await connection.end();
        res.json({ success: true });
    } catch (error) {
        res.status(400).json({ success: false, message: 'รหัสซ้ำหรือข้อมูลไม่ถูกต้อง' });
    }
});

// อัปเดตสถานะ Top 5
app.put('/api/contestants/:id/top5', async (req, res) => {
    const { id } = req.params;
    const { is_top5 } = req.body;
    try {
        const connection = await mysql.createConnection(dbConfig);
        await connection.execute('UPDATE contestants SET is_top5 = ? WHERE id = ?', [is_top5, id]);
        await connection.end();
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ success: false, error: 'Failed to update status' });
    }
});

// ==========================================
// 4. ระบบจัดการคะแนน
// ==========================================
app.get('/api/scores', async (req, res) => {
    try {
        const connection = await mysql.createConnection(dbConfig);
        const [rows] = await connection.execute('SELECT * FROM scores');
        await connection.end();
        res.json(rows);
    } catch (error) {
        res.status(500).json({ error: 'Database connection failed' });
    }
});

app.post('/api/scores', async (req, res) => {
    const { judge_id, contestant_id, scores } = req.body;
    try {
        const connection = await mysql.createConnection(dbConfig);
        const query = `
            INSERT INTO scores (judge_id, contestant_id, score_intro, score_theme, score_speech, score_formal, score_qa) 
            VALUES (?, ?, ?, ?, ?, ?, ?)
            ON DUPLICATE KEY UPDATE 
                score_intro = VALUES(score_intro),
                score_theme = VALUES(score_theme),
                score_speech = VALUES(score_speech),
                score_formal = VALUES(score_formal),
                score_qa = VALUES(score_qa)
        `;
        await connection.execute(query, [
            judge_id, contestant_id, 
            scores.intro, scores.theme, scores.speech, scores.formal, scores.qa
        ]);
        await connection.end();
        res.json({ success: true, message: 'บันทึกคะแนนสำเร็จ' });
    } catch (error) {
        res.status(500).json({ success: false, error: 'Failed to save score' });
    }
});

// ==========================================
// 5. API ส่งออกผลคะแนนเป็น Excel
// ==========================================
app.get('/api/export', async (req, res) => {
    try {
        const connection = await mysql.createConnection(dbConfig);
        const [contestants] = await connection.execute('SELECT * FROM contestants');
        const [scores] = await connection.execute('SELECT * FROM scores');
        await connection.end();

        const workbook = new excelJS.Workbook();
        
        // แยกชีตตามหมวดหมู่
        const categories = { mister: 'Mister', miss: 'Miss', queen: 'Miss Queen', congeniality: 'Congeniality', jumbo: 'Jumbo' };
        
        for (const [catKey, catName] of Object.entries(categories)) {
            const worksheet = workbook.addWorksheet(catName);
            
            worksheet.columns = [
                { header: 'รหัส', key: 'id', width: 10 },
                { header: 'ชื่อ-นามสกุล', key: 'name', width: 30 },
                { header: 'ก.1', key: 'j1', width: 10 },
                { header: 'ก.2', key: 'j2', width: 10 },
                { header: 'ก.3', key: 'j3', width: 10 },
                { header: 'ก.4', key: 'j4', width: 10 },
                { header: 'ก.5', key: 'j5', width: 10 },
                { header: 'คะแนนรวม', key: 'total', width: 15 },
                { header: 'Top 5', key: 'top5', width: 10 }
            ];

            let catContestants = contestants.filter(c => c.category === catKey);
            
            const rowsData = catContestants.map(c => {
                let j1=0, j2=0, j3=0, j4=0, j5=0;
                
                scores.filter(s => s.contestant_id === c.id).forEach(s => {
                    const sum = s.score_intro + s.score_theme + s.score_speech + s.score_formal + s.score_qa;
                    if(s.judge_id === 'judge1') j1 = sum;
                    if(s.judge_id === 'judge2') j2 = sum;
                    if(s.judge_id === 'judge3') j3 = sum;
                    if(s.judge_id === 'judge4') j4 = sum;
                    if(s.judge_id === 'judge5') j5 = sum;
                });

                const total = j1 + j2 + j3 + j4 + j5;
                return { id: c.id, name: c.name, j1, j2, j3, j4, j5, total, top5: c.is_top5 ? 'Y' : '' };
            });

            // เรียงคะแนนจากมากไปน้อย
            rowsData.sort((a, b) => b.total - a.total);
            worksheet.addRows(rowsData);
        }

        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.setHeader('Content-Disposition', 'attachment; filename=freshy2026_scores.xlsx');
        
        await workbook.xlsx.write(res);
        res.end();

    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Failed to generate Excel' });
    }
});

app.listen(port, () => {
    console.log(`=================================`);
    console.log(`🚀 Server RMUTK FRESHY 2026 is running!`);
    console.log(`=================================`);
});