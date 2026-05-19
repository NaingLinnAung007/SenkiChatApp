const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const path = require('path');
const bcrypt = require('bcryptjs');
const multer = require('multer');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const db = require('./database');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
    cors: { origin: "*" }
});

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));
app.use('/uploads', express.static('uploads'));

if (!fs.existsSync('public/uploads')) {
    fs.mkdirSync('public/uploads', { recursive: true });
}

const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, 'public/uploads/'),
    filename: (req, file, cb) => cb(null, Date.now() + '-' + file.originalname)
});
const upload = multer({ storage });

// Online users tracking
const onlineUsers = new Map(); // socketId -> userId
const userSockets = new Map(); // userId -> socketId

function runQuery(sql, params = []) {
    return new Promise((resolve, reject) => {
        db.all(sql, params, (err, rows) => {
            if (err) reject(err);
            else resolve(rows);
        });
    });
}

function run(sql, params = []) {
    return new Promise((resolve, reject) => {
        db.run(sql, params, function(err) {
            if (err) reject(err);
            else resolve({ id: this.lastID, changes: this.changes });
        });
    });
}

// ========== API ROUTES ==========

app.post('/api/register', async (req, res) => {
    try {
        const { username, email, password } = req.body;
        const existing = await runQuery('SELECT * FROM users WHERE username = ? OR email = ?', [username, email]);
        if (existing.length > 0) {
            return res.json({ success: false, error: 'Username or email already exists' });
        }
        const hashedPassword = await bcrypt.hash(password, 10);
        const result = await run(
            'INSERT INTO users (username, email, password) VALUES (?, ?, ?)',
            [username, email, hashedPassword]
        );
        const user = await runQuery('SELECT id, username, email, profile_picture, bio FROM users WHERE id = ?', [result.id]);
        res.json({ success: true, user: user[0] });
    } catch (error) {
        res.json({ success: false, error: error.message });
    }
});

app.post('/api/login', async (req, res) => {
    try {
        const { username, password } = req.body;
        const users = await runQuery('SELECT * FROM users WHERE username = ?', [username]);
        if (users.length === 0) {
            return res.json({ success: false, error: 'Invalid credentials' });
        }
        const user = users[0];
        const valid = await bcrypt.compare(password, user.password);
        if (!valid) {
            return res.json({ success: false, error: 'Invalid credentials' });
        }
        res.json({ 
            success: true, 
            user: { 
                id: user.id, 
                username: user.username, 
                email: user.email, 
                profile_picture: user.profile_picture,
                bio: user.bio 
            } 
        });
    } catch (error) {
        res.json({ success: false, error: error.message });
    }
});

app.post('/api/update-profile', upload.single('profilePicture'), async (req, res) => {
    try {
        const { userId, bio } = req.body;
        let updateQuery = 'UPDATE users SET bio = ?';
        let params = [bio];
        if (req.file) {
            updateQuery = 'UPDATE users SET bio = ?, profile_picture = ?';
            params = [bio, '/uploads/' + req.file.filename];
        }
        params.push(userId);
        await run(updateQuery + ' WHERE id = ?', params);
        const user = await runQuery('SELECT id, username, email, profile_picture, bio FROM users WHERE id = ?', [userId]);
        res.json({ success: true, user: user[0] });
    } catch (error) {
        res.json({ success: false, error: error.message });
    }
});

app.get('/api/users', async (req, res) => {
    try {
        const users = await runQuery('SELECT id, username, profile_picture, bio, status FROM users');
        res.json({ success: true, users: users.map(u => ({
            id: u.id,
            username: u.username,
            profile_picture: u.profile_picture,
            bio: u.bio,
            status: userSockets.has(u.id.toString()) ? 'online' : 'offline'
        })) });
    } catch (error) {
        res.json({ success: false, error: error.message });
    }
});

app.get('/api/friends/:userId', async (req, res) => {
    try {
        const { userId } = req.params;
        const friends = await runQuery(`
            SELECT u.id, u.username, u.profile_picture, u.status, u.bio
            FROM friends f
            JOIN users u ON (f.friend_id = u.id OR f.user_id = u.id)
            WHERE (f.user_id = ? OR f.friend_id = ?) AND u.id != ?
        `, [userId, userId, userId]);
        // Add real online status
        const friendsWithStatus = friends.map(f => ({
            ...f,
            status: userSockets.has(f.id.toString()) ? 'online' : 'offline'
        }));
        res.json({ success: true, friends: friendsWithStatus });
    } catch (error) {
        res.json({ success: false, error: error.message });
    }
});

app.get('/api/friend-requests/:userId', async (req, res) => {
    try {
        const { userId } = req.params;
        const requests = await runQuery(`
            SELECT fr.*, u.username, u.profile_picture, u.status
            FROM friend_requests fr
            JOIN users u ON fr.from_user = u.id
            WHERE fr.to_user = ? AND fr.status = 'pending'
        `, [userId]);
        res.json({ success: true, requests });
    } catch (error) {
        res.json({ success: false, error: error.message });
    }
});

app.post('/api/friend-request', async (req, res) => {
    try {
        const { fromUserId, toUserId } = req.body;
        
        const existingFriend = await runQuery(
            'SELECT * FROM friends WHERE (user_id = ? AND friend_id = ?) OR (user_id = ? AND friend_id = ?)',
            [fromUserId, toUserId, toUserId, fromUserId]
        );
        if (existingFriend.length > 0) {
            return res.json({ success: false, error: 'Already friends' });
        }
        
        const existingRequest = await runQuery(
            'SELECT * FROM friend_requests WHERE from_user = ? AND to_user = ? AND status = "pending"',
            [fromUserId, toUserId]
        );
        if (existingRequest.length > 0) {
            return res.json({ success: false, error: 'Friend request already sent' });
        }
        
        await run(
            'INSERT INTO friend_requests (from_user, to_user) VALUES (?, ?)',
            [fromUserId, toUserId]
        );
        
        const sender = await runQuery('SELECT id, username, profile_picture FROM users WHERE id = ?', [fromUserId]);
        const recipientSocketId = userSockets.get(toUserId.toString());
        if (recipientSocketId) {
            io.to(recipientSocketId).emit('friend request received', {
                id: fromUserId,
                username: sender[0].username,
                profile_picture: sender[0].profile_picture
            });
        }
        
        res.json({ success: true });
    } catch (error) {
        res.json({ success: false, error: error.message });
    }
});

app.post('/api/accept-friend-request', async (req, res) => {
    try {
        const { requestId, fromUserId, toUserId } = req.body;
        
        await run('DELETE FROM friend_requests WHERE id = ?', [requestId]);
        await run('INSERT INTO friends (user_id, friend_id) VALUES (?, ?)', [fromUserId, toUserId]);
        await run('INSERT INTO friends (user_id, friend_id) VALUES (?, ?)', [toUserId, fromUserId]);
        
        res.json({ success: true });
    } catch (error) {
        res.json({ success: false, error: error.message });
    }
});

app.post('/api/decline-friend-request', async (req, res) => {
    try {
        const { requestId } = req.body;
        await run('DELETE FROM friend_requests WHERE id = ?', [requestId]);
        res.json({ success: true });
    } catch (error) {
        res.json({ success: false, error: error.message });
    }
});

app.get('/api/messages/:userId/:otherId', async (req, res) => {
    try {
        const { userId, otherId } = req.params;
        
        const areFriends = await runQuery(
            'SELECT * FROM friends WHERE (user_id = ? AND friend_id = ?) OR (user_id = ? AND friend_id = ?)',
            [userId, otherId, otherId, userId]
        );
        
        if (areFriends.length === 0 && userId != otherId) {
            return res.json({ success: false, error: 'Not friends', messages: [] });
        }
        
        const messages = await runQuery(`
            SELECT m.*, u.username, u.profile_picture 
            FROM messages m
            JOIN users u ON m.from_user = u.id
            WHERE ((m.from_user = ? AND m.to_user = ?) OR (m.from_user = ? AND m.to_user = ?))
            AND (m.is_group = 0 OR m.is_group IS NULL)
            AND (m.is_deleted = 0 OR m.is_deleted IS NULL)
            ORDER BY m.created_at ASC LIMIT 100
        `, [userId, otherId, otherId, userId]);
        
        res.json({ success: true, messages });
    } catch (error) {
        res.json({ success: false, error: error.message });
    }
});

app.post('/api/groups', async (req, res) => {
    try {
        const { name, description, createdBy } = req.body;
        const groupId = uuidv4();
        await run(
            'INSERT INTO groups (group_id, name, description, created_by) VALUES (?, ?, ?, ?)',
            [groupId, name, description || '', createdBy]
        );
        await run(
            'INSERT INTO group_members (group_id, user_id, role) VALUES (?, ?, ?)',
            [groupId, createdBy, 'admin']
        );
        res.json({ success: true, groupId });
    } catch (error) {
        res.json({ success: false, error: error.message });
    }
});

app.get('/api/groups/:userId', async (req, res) => {
    try {
        const { userId } = req.params;
        const groups = await runQuery(`
            SELECT g.* FROM groups g
            JOIN group_members gm ON g.group_id = gm.group_id
            WHERE gm.user_id = ?
        `, [userId]);
        res.json({ success: true, groups });
    } catch (error) {
        res.json({ success: false, error: error.message });
    }
});

app.get('/api/group-members/:groupId', async (req, res) => {
    try {
        const { groupId } = req.params;
        const members = await runQuery(`
            SELECT gm.*, u.username, u.profile_picture, u.status
            FROM group_members gm
            JOIN users u ON gm.user_id = u.id
            WHERE gm.group_id = ?
        `, [groupId]);
        res.json({ success: true, members });
    } catch (error) {
        res.json({ success: false, error: error.message });
    }
});

app.post('/api/groups/add-member', async (req, res) => {
    try {
        const { groupId, userId, adminId } = req.body;
        
        const adminCheck = await runQuery(
            'SELECT * FROM group_members WHERE group_id = ? AND user_id = ? AND role = "admin"',
            [groupId, adminId]
        );
        
        if (adminCheck.length === 0) {
            return res.json({ success: false, error: 'Only admins can add members' });
        }
        
        await run(
            'INSERT OR IGNORE INTO group_members (group_id, user_id, role) VALUES (?, ?, ?)',
            [groupId, userId, 'member']
        );
        
        const group = await runQuery('SELECT name FROM groups WHERE group_id = ?', [groupId]);
        const recipientSocketId = userSockets.get(userId.toString());
        if (recipientSocketId && group.length > 0) {
            io.to(recipientSocketId).emit('added to group', { groupId, groupName: group[0].name });
        }
        
        res.json({ success: true });
    } catch (error) {
        res.json({ success: false, error: error.message });
    }
});

app.get('/api/group-messages/:groupId', async (req, res) => {
    try {
        const { groupId } = req.params;
        const messages = await runQuery(`
            SELECT m.*, u.username, u.profile_picture 
            FROM messages m
            JOIN users u ON m.from_user = u.id
            WHERE m.group_id = ? AND (m.is_deleted = 0 OR m.is_deleted IS NULL)
            ORDER BY m.created_at ASC LIMIT 100
        `, [groupId]);
        res.json({ success: true, messages });
    } catch (error) {
        res.json({ success: false, error: error.message });
    }
});

app.put('/api/messages/:messageId', async (req, res) => {
    try {
        const { messageId } = req.params;
        const { message } = req.body;
        await run(
            'UPDATE messages SET message = ?, is_edited = 1, edited_at = CURRENT_TIMESTAMP WHERE message_id = ?',
            [message, messageId]
        );
        res.json({ success: true });
    } catch (error) {
        res.json({ success: false, error: error.message });
    }
});

app.delete('/api/messages/:messageId', async (req, res) => {
    try {
        const { messageId } = req.params;
        await run('UPDATE messages SET message = "This message was deleted", is_deleted = 1 WHERE message_id = ?', [messageId]);
        res.json({ success: true });
    } catch (error) {
        res.json({ success: false, error: error.message });
    }
});

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ========== SOCKET.IO ==========
io.on('connection', (socket) => {
    console.log('🔌 New connection:', socket.id);

    socket.on('user connected', async (userId) => {
        if (!userId) return;
        
        try {
            // Store user connection
            const oldSocketId = userSockets.get(userId.toString());
            if (oldSocketId && oldSocketId !== socket.id) {
                // Remove old connection
                onlineUsers.delete(oldSocketId);
            }
            
            userSockets.set(userId.toString(), socket.id);
            onlineUsers.set(socket.id, userId.toString());
            socket.userId = userId.toString();
            
            // Update database status
            await run('UPDATE users SET status = ?, last_seen = CURRENT_TIMESTAMP WHERE id = ?', ['online', userId]);
            
            console.log(`✅ User ${userId} is now online`);
            
            // Broadcast online status to all users
            const allUsers = await runQuery('SELECT id, username, profile_picture FROM users');
            const onlineList = allUsers.map(u => ({
                id: u.id,
                username: u.username,
                profile_picture: u.profile_picture,
                status: userSockets.has(u.id.toString()) ? 'online' : 'offline'
            }));
            io.emit('online users update', onlineList);
            
            socket.join(`user_${userId}`);
        } catch (error) {
            console.error('Error in user connected:', error);
        }
    });

    socket.on('private message', async (data) => {
        const { fromUserId, toUserId, message } = data;
        
        // Check if friends
        const areFriends = await runQuery(
            'SELECT * FROM friends WHERE (user_id = ? AND friend_id = ?) OR (user_id = ? AND friend_id = ?)',
            [fromUserId, toUserId, toUserId, fromUserId]
        );
        
        if (areFriends.length === 0 && fromUserId != toUserId) {
            socket.emit('error', 'You can only message friends');
            return;
        }
        
        try {
            const messageId = uuidv4();
            await run(
                'INSERT INTO messages (message_id, from_user, to_user, message, is_private) VALUES (?, ?, ?, ?, 1)',
                [messageId, fromUserId, toUserId, message]
            );
            
            const sender = await runQuery('SELECT username, profile_picture FROM users WHERE id = ?', [fromUserId]);
            const now = new Date();
            const msgData = {
                message_id: messageId,
                from: fromUserId,
                fromUsername: sender[0].username,
                fromProfilePicture: sender[0].profile_picture,
                message: message,
                time: now.toLocaleTimeString(),
                date: now.toLocaleDateString(),
                is_edited: 0,
                is_deleted: 0
            };
            
            // Send to recipient if online
            const recipientSocketId = userSockets.get(toUserId.toString());
            if (recipientSocketId) {
                io.to(recipientSocketId).emit('new private message', msgData);
            }
            
            // Send confirmation to sender (only once)
            socket.emit('message sent', msgData);
        } catch (error) {
            console.error('Error in private message:', error);
        }
    });
    
    socket.on('group message', async (data) => {
        const { fromUserId, groupId, message } = data;
        
        const isMember = await runQuery(
            'SELECT * FROM group_members WHERE group_id = ? AND user_id = ?',
            [groupId, fromUserId]
        );
        
        if (isMember.length === 0) return;
        
        try {
            const messageId = uuidv4();
            await run(
                'INSERT INTO messages (message_id, from_user, group_id, message, is_group) VALUES (?, ?, ?, ?, 1)',
                [messageId, fromUserId, groupId, message]
            );
            
            const sender = await runQuery('SELECT username, profile_picture FROM users WHERE id = ?', [fromUserId]);
            const now = new Date();
            const msgData = {
                message_id: messageId,
                from: fromUserId,
                fromUsername: sender[0].username,
                fromProfilePicture: sender[0].profile_picture,
                groupId: groupId,
                message: message,
                time: now.toLocaleTimeString(),
                date: now.toLocaleDateString(),
                is_edited: 0,
                is_deleted: 0
            };
            
            io.to(`group_${groupId}`).emit('new group message', msgData);
        } catch (error) {
            console.error('Error in group message:', error);
        }
    });
    
    socket.on('edit message', async (data) => {
        const { messageId, message, toUserId, groupId, isGroup } = data;
        try {
            await run('UPDATE messages SET message = ?, is_edited = 1 WHERE message_id = ?', [message, messageId]);
            const editData = { messageId, message, is_edited: 1 };
            
            if (isGroup && groupId) {
                io.to(`group_${groupId}`).emit('message edited', editData);
            } else if (toUserId) {
                const recipientSocketId = userSockets.get(toUserId.toString());
                if (recipientSocketId) {
                    io.to(recipientSocketId).emit('message edited', editData);
                }
            }
            socket.emit('message edited', editData);
        } catch (error) {
            console.error(error);
        }
    });
    
    socket.on('delete message', async (data) => {
        const { messageId, toUserId, groupId, isGroup } = data;
        try {
            await run('UPDATE messages SET message = "This message was deleted", is_deleted = 1 WHERE message_id = ?', [messageId]);
            const deleteData = { messageId, message: "This message was deleted", is_deleted: 1 };
            
            if (isGroup && groupId) {
                io.to(`group_${groupId}`).emit('message deleted', deleteData);
            } else if (toUserId) {
                const recipientSocketId = userSockets.get(toUserId.toString());
                if (recipientSocketId) {
                    io.to(recipientSocketId).emit('message deleted', deleteData);
                }
            }
            socket.emit('message deleted', deleteData);
        } catch (error) {
            console.error(error);
        }
    });
    
    socket.on('join group', (groupId) => {
        socket.join(`group_${groupId}`);
    });
    
    socket.on('typing', (data) => {
        const { toUserId, groupId, fromUserId, username, isGroup } = data;
        
        if (isGroup && groupId) {
            socket.to(`group_${groupId}`).emit('user typing', { userId: fromUserId, username });
        } else if (toUserId) {
            const recipientSocketId = userSockets.get(toUserId.toString());
            if (recipientSocketId) {
                io.to(recipientSocketId).emit('user typing', { userId: fromUserId, username });
            }
        }
    });

    socket.on('disconnect', async () => {
        const userId = socket.userId;
        if (userId) {
            try {
                console.log(`🔴 User ${userId} disconnected`);
                
                // Remove from maps
                onlineUsers.delete(socket.id);
                if (userSockets.get(userId) === socket.id) {
                    userSockets.delete(userId);
                }
                
                // Update database status
                await run('UPDATE users SET status = ?, last_seen = CURRENT_TIMESTAMP WHERE id = ?', ['offline', userId]);
                
                // Broadcast updated online status
                const allUsers = await runQuery('SELECT id, username, profile_picture FROM users');
                const onlineList = allUsers.map(u => ({
                    id: u.id,
                    username: u.username,
                    profile_picture: u.profile_picture,
                    status: userSockets.has(u.id.toString()) ? 'online' : 'offline'
                }));
                io.emit('online users update', onlineList);
            } catch (error) {
                console.error('Error in disconnect:', error);
            }
        }
    });
});

const PORT = 3000;
server.listen(PORT, () => {
    console.log(`
    ═══════════════════════════════════════
    ✅ Pro Chat App V3 စတင်အလုပ်လုပ်နေပါပြီ
    🌐 http://localhost:${PORT}
    ═══════════════════════════════════════
    `);
});