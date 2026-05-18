const { Pool } = require('pg');

const pool = new Pool({
    connectionString: process.env.DATABASE_URL || 'postgresql://postgres:postgres@localhost:5432/chatdb',
    ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false
});

async function runQuery(sql, params = []) {
    try {
        const result = await pool.query(sql, params);
        return result.rows;
    } catch (err) {
        console.error('Query error:', err);
        throw err;
    }
}

async function run(sql, params = []) {
    try {
        const result = await pool.query(sql, params);
        return { id: result.rows[0]?.id, changes: result.rowCount };
    } catch (err) {
        console.error('Run error:', err);
        throw err;
    }
}

async function initDatabase() {
    const queries = [
        `CREATE TABLE IF NOT EXISTS users (
            id SERIAL PRIMARY KEY,
            username TEXT UNIQUE NOT NULL,
            email TEXT UNIQUE NOT NULL,
            password TEXT NOT NULL,
            profile_picture TEXT DEFAULT '/uploads/default-avatar.png',
            bio TEXT DEFAULT 'Hello! I am using Pro Chat App',
            status TEXT DEFAULT 'offline',
            last_seen TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )`,
        
        `CREATE TABLE IF NOT EXISTS friend_requests (
            id SERIAL PRIMARY KEY,
            from_user INTEGER NOT NULL REFERENCES users(id),
            to_user INTEGER NOT NULL REFERENCES users(id),
            status TEXT DEFAULT 'pending',
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            UNIQUE(from_user, to_user)
        )`,
        
        `CREATE TABLE IF NOT EXISTS friends (
            id SERIAL PRIMARY KEY,
            user_id INTEGER NOT NULL REFERENCES users(id),
            friend_id INTEGER NOT NULL REFERENCES users(id),
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            UNIQUE(user_id, friend_id)
        )`,
        
        `CREATE TABLE IF NOT EXISTS messages (
            id SERIAL PRIMARY KEY,
            message_id TEXT UNIQUE NOT NULL,
            from_user INTEGER NOT NULL REFERENCES users(id),
            to_user INTEGER REFERENCES users(id),
            group_id TEXT,
            message TEXT NOT NULL,
            is_private INTEGER DEFAULT 0,
            is_group INTEGER DEFAULT 0,
            is_edited INTEGER DEFAULT 0,
            is_deleted INTEGER DEFAULT 0,
            read INTEGER DEFAULT 0,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            edited_at TIMESTAMP
        )`,
        
        `CREATE TABLE IF NOT EXISTS groups (
            id SERIAL PRIMARY KEY,
            group_id TEXT UNIQUE NOT NULL,
            name TEXT NOT NULL,
            description TEXT,
            profile_picture TEXT DEFAULT '/uploads/default-group.png',
            created_by INTEGER NOT NULL REFERENCES users(id),
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )`,
        
        `CREATE TABLE IF NOT EXISTS group_members (
            id SERIAL PRIMARY KEY,
            group_id TEXT NOT NULL REFERENCES groups(group_id),
            user_id INTEGER NOT NULL REFERENCES users(id),
            role TEXT DEFAULT 'member',
            joined_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            UNIQUE(group_id, user_id)
        )`
    ];
    
    for (const query of queries) {
        try {
            await pool.query(query);
        } catch (err) {
            console.error('Error creating table:', err);
        }
    }
    
    console.log('✅ PostgreSQL database initialized');
}

module.exports = { pool, runQuery, run, initDatabase };