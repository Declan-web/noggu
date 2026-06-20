const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    }
});

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.static(__dirname));

function sendIndexHtml(req, res) {
    const publicPath = path.join(__dirname, 'public', 'index.html');
    const rootPath = path.join(__dirname, 'index.html');
    if (fs.existsSync(publicPath)) {
        res.sendFile(publicPath);
    } else if (fs.existsSync(rootPath)) {
        res.sendFile(rootPath);
    } else {
        res.send(`<body style="background:#222; color:#fff; text-align:center; padding-top:100px; font-family:sans-serif;"><h2>⚠️ index.html 파일을 찾을 수 없습니다.</h2></body>`);
    }
}

app.get('/', (req, res) => { sendIndexHtml(req, res); });

// 글로벌 인메모리 룸 데이터베이스
let roomsData = {};

const COURT_WIDTH = 1000;
const COURT_HEIGHT = 500;
const FRICTION = 0.98;

function getOrCreateRoom(roomId) {
    if (!roomsData[roomId]) {
        roomsData[roomId] = {
            gameState: "SETUP",
            scoreBlue: 0,
            scoreRed: 0,
            teamBlueName: "TEAM BLUE",
            teamRedName: "TEAM RED",
            maxBluePlayers: 5,
            maxRedPlayers: 5,
            directorName: null,
            directorToken: null,
            globalDefenseLockUntil: 0,
            miniGameGauge: 25, // 0~50 기준 중앙 25 시작
            activeDefender: null,
            activeAttacker: null,
            miniGameTimerId: null, // 5초 타임어택 스케줄러 타이머
            registeredOwners: [],
            logs: [],
            ballState: {
                x: 500,
                y: 250,
                vx: 0,
                vy: 0,
                holderId: null,
                holderTeam: null,
                isFlying: false,
                lastShooterSkill: 5.0,
                lastUpdate: Date.now()
            }
        };
    }
    return roomsData[roomId];
}

function addLog(room, type, message) {
    const now = new Date();
    const timestamp = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}:${String(now.getSeconds()).padStart(2, '0')}`;
    const logEntry = { type, message, timestamp };
    room.logs.push(logEntry);
    if (room.logs.length > 40) room.logs.shift();
    return logEntry;
}

// 실시간 프레임별 공 물리 연산 엔진 루프 (60FPS)
setInterval(() => {
    Object.keys(roomsData).forEach(roomId => {
        const room = roomsData[roomId];
        if (room.gameState !== "PLAYING" || room.ballState.holderId) return;

        const ball = room.ballState;
        if (ball.isFlying) {
            ball.x += ball.vx;
            ball.y += ball.vy;
            ball.vx *= FRICTION;
            ball.vy *= FRICTION;

            // 벽면 튕기기 바운스 물리 연산
            if (ball.x < 8 || ball.x > COURT_WIDTH - 8) {
                ball.vx *= -1;
                ball.x = ball.x < 8 ? 8 : COURT_WIDTH - 8;
            }
            if (ball.y < 8 || ball.y > COURT_HEIGHT - 8) {
                ball.vy *= -1;
                ball.y = ball.y < 8 ? 8 : COURT_HEIGHT - 8;
            }

            if (Math.abs(ball.vx) < 0.1 && Math.abs(ball.vy) < 0.1) {
                ball.vx = 0;
                ball.vy = 0;
                ball.isFlying = false;
            }

            // 원격 클라이언트에 갱신된 공 물리 좌표 전송
            io.to(roomId).emit('onBallAction', ball);
        }
    });
}, 1000 / 60);

io.on('connection', (socket) => {
    let currentRoomId = null;
    let userProfileName = null;

    socket.on('joinRoom', (data) => {
        const { roomId, userName } = data;
        if (!roomId || !userName) return;

        currentRoomId = roomId;
        userProfileName = userName;
        socket.join(roomId);

        const room = getOrCreateRoom(roomId);
        const existingPlayer = room.registeredOwners.find(p => p.ownerName === userName);
        if (existingPlayer) {
            existingPlayer.socketId = socket.id;
        }

        socket.emit('authResult', { success: true });
        io.to(roomId).emit('onInitRoomState', room);
    });

    socket.on('syncRegisterOwner', (data) => {
        if (!currentRoomId) return;
        const room = getOrCreateRoom(currentRoomId);
        
        const duplicate = room.registeredOwners.find(p => p.ownerName === data.ownerName);
        if (duplicate && data.ownerName !== "") return;

        room.registeredOwners = room.registeredOwners.filter(p => !(p.team === data.team && p.id === data.id));

        if (data.ownerName !== "") {
            room.registeredOwners.push({
                team: data.team,
                id: data.id,
                ownerName: data.ownerName,
                password: data.password,
                socketId: socket.id,
                x: data.x,
                y: data.y,
                angle: data.angle,
                skillLevel: 5.0
            });
            const log = addLog(room, 'chat', `${data.ownerName} 선수가 [${data.team} ${data.id}번] 자리에 등록되었습니다.`);
            io.to(currentRoomId).emit('onNewLog', log);
        }

        io.to(currentRoomId).emit('onInitRoomState', room);
    });

    socket.on('syncPlayerMove', (data) => {
        if (!currentRoomId) return;
        const room = getOrCreateRoom(currentRoomId);
        const p = room.registeredOwners.find(o => o.team === data.team && o.id === data.id);
        if (p) {
            p.x = data.x;
            p.y = data.y;
            p.angle = data.angle;
        }
        socket.to(currentRoomId).emit('onPlayerMove', data);
    });

    socket.on('syncBallAction', (data) => {
        if (!currentRoomId) return;
        const room = getOrCreateRoom(currentRoomId);
        
        room.ballState.x = data.x;
        room.ballState.y = data.y;
        room.ballState.vx = data.vx;
        room.ballState.vy = data.vy;
        room.ballState.isFlying = data.isFlying;
        room.ballState.holderId = data.holderId || null;
        room.ballState.holderTeam = data.holderTeam || null;
        room.ballState.lastShooterSkill = data.lastShooterSkill || 5.0;

        io.to(currentRoomId).emit('onBallAction', room.ballState);
    });

    socket.on('syncStartGame', (data) => {
        if (!currentRoomId) return;
        const room = getOrCreateRoom(currentRoomId);
        room.gameState = "PLAYING";
        room.teamBlueName = data.teamBlueName;
        room.teamRedName = data.teamRedName;
        room.globalDefenseLockUntil = 0;
        
        io.to(currentRoomId).emit('onInitRoomState', room);
        const log = addLog(room, 'score', "시합이 개시되었습니다!");
        io.to(currentRoomId).emit('onNewLog', log);
    });

    socket.on('syncTogglePause', () => {
        if (!currentRoomId) return;
        const room = getOrCreateRoom(currentRoomId);
        room.gameState = (room.gameState === "PLAYING") ? "PAUSE" : "PLAYING";
        io.to(currentRoomId).emit('onInitRoomState', room);
    });

    // 📌 리셋 버튼 클릭 시 모든 포지션, 선택 기록 및 캐릭터 세션 정보를 서버에서 완전히 지우는 오류 수정본
    socket.on('syncResetMatch', () => {
        if (!currentRoomId) return;
        const room = roomsData[currentRoomId];
        if (room && room.miniGameTimerId) {
            clearTimeout(room.miniGameTimerId);
        }
        delete roomsData[currentRoomId]; 
        io.to(currentRoomId).emit('onResetMatch');
    });

    socket.on('syncScore', (data) => {
        if (!currentRoomId) return;
        const room = getOrCreateRoom(currentRoomId);
        room.scoreBlue = data.blue;
        room.scoreRed = data.red;
        
        io.to(currentRoomId).emit('onInitRoomState', room);
        const targetTeamName = data.scoringTeam === "BLUE" ? room.teamBlueName : room.teamRedName;
        const log = addLog(room, 'score', `🎉 [득점] ${targetTeamName} 팀 득점! (${room.scoreBlue} VS ${room.scoreRed})`);
        io.to(currentRoomId).emit('onNewLog', log);
    });

    socket.on('syncUpdateSkillLevel', (data) => {
        if (!currentRoomId) return;
        const room = getOrCreateRoom(currentRoomId);
        const p = room.registeredOwners.find(o => o.team === data.team && o.id === data.id);
        if (p) p.skillLevel = data.skillLevel;
    });

    socket.on('syncRegisterDirector', (data) => {
        if (!currentRoomId) return;
        const room = getOrCreateRoom(currentRoomId);
        room.directorName = data.name;
        room.directorToken = data.token;
        io.to(currentRoomId).emit('onInitRoomState', room);
    });

    // 📌 공격(황금색: #FFD700)과 수비(보라색: #8A2BE2)의 전용 색상 적용 및 디펜스 결투 개시
    socket.on('syncStartMiniGame', (data) => {
        if (!currentRoomId) return;
        const room = getOrCreateRoom(currentRoomId);
        if (room.miniGameTimerId) clearTimeout(room.miniGameTimerId);

        room.gameState = "MINIGAME";
        room.miniGameGauge = 25; 
        room.activeDefender = { team: data.defTeam, id: data.defId };
        room.activeAttacker = { team: data.attTeam, id: data.attId };
        
        io.to(currentRoomId).emit('onStartMiniGame', {
            ...data,
            attackerColor: '#FFD700', 
            defenderColor: '#8A2BE2'  
        });

        // 📌 [핵심 변경] 중간에 끝내지 않고 정확히 5초 동안 연타를 기록한 후 타이머가 만료되었을 때 승자를 판정함
        room.miniGameTimerId = setTimeout(() => {
            handleMiniGameTimeout(currentRoomId);
        }, 5000);
    });

    socket.on('syncMiniGameHit', (role) => {
        if (!currentRoomId) return;
        const room = roomsData[currentRoomId];
        if (!room || room.gameState !== "MINIGAME") return;

        if (role === "DEFENDER") room.miniGameGauge += 1;
        else if (role === "ATTACKER") room.miniGameGauge -= 1;

        if (room.miniGameGauge > 50) room.miniGameGauge = 50;
        if (room.miniGameGauge < 0) room.miniGameGauge = 0;

        io.to(currentRoomId).emit('onMiniGameGauge', room.miniGameGauge);
    });

    // 📌 [핵심 변경] 5초 타임업 시점에 게이지를 더 많이 채운 쪽을 판정하여 소유권 부여
    function handleMiniGameTimeout(roomId) {
        const room = roomsData[roomId];
        if (!room || room.gameState !== "MINIGAME") return;

        room.gameState = "PLAYING";
        room.globalDefenseLockUntil = Date.now() + 5000;

        // 기준점인 중앙값 25보다 크면 수비진영(보라색)이 더 많이 채운 것이므로 수비 승리 (스틸)
        if (room.miniGameGauge > 25) {
            room.ballState.holderTeam = room.activeDefender.team;
            room.ballState.holderId = room.activeDefender.id;
            room.ballState.isFlying = false;

            const log = addLog(room, 'defense', `🛡️ [타임업] 수비진영(보라색) 판정승! 공을 스틸했습니다.`);
            io.to(roomId).emit('onNewLog', log);
        } else { 
            // 기준점 25 이하이면 공격진영(황금색)이 더 많이 채웠거나 유지한 것이므로 공격 승리 (돌파 및 유지)
            room.ballState.holderTeam = room.activeAttacker.team;
            room.ballState.holderId = room.activeAttacker.id;
            room.ballState.isFlying = false;

            const log = addLog(room, 'defense', `⚡ [타임업] 공격진영(황금색) 판정승! 소유권을 안전하게 지켜냈습니다.`);
            io.to(roomId).emit('onNewLog', log);
        }
        io.to(roomId).emit('onEndMiniGame');
        io.to(roomId).emit('onInitRoomState', room);
    }

    socket.on('disconnect', () => {});
});

const PORT = 3000;
server.listen(PORT, () => { console.log(`서버 오픈: http://localhost:${PORT}`); });
