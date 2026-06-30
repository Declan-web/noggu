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

// 정적 파일 서버 디렉터리 바인딩
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.static(__dirname));

// 안전한 HTML 파일 제공 함수
function sendIndexHtml(req, res) {
    const publicPath = path.join(__dirname, 'public', 'index.html');
    const rootPath = path.join(__dirname, 'index.html');
    
    if (fs.existsSync(publicPath)) {
        res.sendFile(publicPath);
    } else if (fs.existsSync(rootPath)) {
        res.sendFile(rootPath);
    } else {
        res.send(`
            <body style="background:#222; color:#fff; text-align:center; padding-top:100px; font-family:sans-serif;">
                <h2>⚠️ index.html 파일을 찾을 수 없습니다.</h2>
                <p>server.js와 같은 폴더 또는 public 폴더 안에 index.html 파일이 있는지 확인해 주세요!</p>
            </body>
        `);
    }
}

app.get('/', (req, res) => {
    sendIndexHtml(req, res);
});

// 글로벌 경기 구역 인메모리 데이터베이스
let roomsData = {};
const COURT_WIDTH = 1000;
const COURT_HEIGHT = 500;
const BALL_MAX_SPEED = 25;
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
            miniGameGauge: 25, // 0(공격 완승) ~ 50(수비 완승) 기점, 시작점은 25 대칭
            activeDefender: null,
            activeAttacker: null,
            miniGameTimerId: null, // 5초 카운트다운용 타이머 홀더
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

// 서버 메인 루프 (60FPS) - 공의 자유 이동은 온전히 서버 주도로 연산 및 브로드캐스트하여 순간 이동 제거
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
            // 소유자가 없을 때 실시간 위치 데이터를 클라이언트에 하향 강제 전송
            io.to(roomId).emit('onBallAction', ball);
        }
    });
}, 1000 / 60);

io.on('connection', (socket) => {
    let currentRoomId = null;
    let userProfileName = null;

    socket.on('joinRoom', (data) => {
        const { roomId, userName, password, isAutoRefresh } = data;
        if (!roomId || !userName) {
            return socket.emit('authResult', { success: false, message: "방 정보 및 이름이 올바르지 않습니다." });
        }

        currentRoomId = roomId;
        userProfileName = userName;
        socket.join(roomId);

        const room = getOrCreateRoom(roomId);
        const existingPlayer = room.registeredOwners.find(p => p.ownerName === userName);
        if (existingPlayer) {
            existingPlayer.socketId = socket.id;
        }

        socket.emit('authResult', { success: true, isAutoRefresh });
        socket.emit('onInitRoomState', room);
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

        io.to(currentRoomId).emit('onRegisterOwner', {
            team: data.team,
            id: data.id,
            ownerName: data.ownerName,
            socketId: socket.id,
            x: data.x,
            y: data.y,
            angle: data.angle
        });
        
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
        
        // 📌 [버그 수정]: 공의 소유자가 지정되어 있거나, 패스/슛/줍기 액션이 직접 발생했을 때만 상태 덮어쓰기 허용 (순간이동 제어)
        if (data.holderId || data.isActionSignal || !room.ballState.isFlying) {
            room.ballState.x = data.x;
            room.ballState.y = data.y;
            room.ballState.vx = data.vx;
            room.ballState.vy = data.vy;
            room.ballState.isFlying = data.isFlying;
            room.ballState.holderId = data.holderId || null;
            room.ballState.holderTeam = data.holderTeam || null;
            room.ballState.lastShooterSkill = data.lastShooterSkill || 5.0;
            socket.to(currentRoomId).emit('onBallAction', room.ballState);
        }
    });

    socket.on('syncMatchCapacity', (data) => {
        if (!currentRoomId) return;
        const room = getOrCreateRoom(currentRoomId);
        room.maxBluePlayers = data.blueMax;
        room.maxRedPlayers = data.redMax;
        io.to(currentRoomId).emit('onMatchCapacityChange', data);
    });

    socket.to(currentRoomId);
    socket.on('syncLiveTeamName', (data) => {
        if (!currentRoomId) return;
        const room = getOrCreateRoom(currentRoomId);
        if (data.team === "BLUE") room.teamBlueName = data.name;
        else room.teamRedName = data.name;
        socket.to(currentRoomId).emit('onLiveTeamName', data);
    });

    socket.on('syncStartGame', (data) => {
        if (!currentRoomId) return;
        const room = getOrCreateRoom(currentRoomId);
        room.gameState = "PLAYING";
        room.teamBlueName = data.teamBlueName;
        room.teamRedName = data.teamRedName;
        room.maxBluePlayers = data.maxBluePlayers;
        room.maxRedPlayers = data.maxRedPlayers;
        room.globalDefenseLockUntil = 0;
        io.to(currentRoomId).emit('onStartGame', data);
        const log = addLog(room, 'score', "시합이 시작되었습니다! 다들 뛰어!");
        io.to(currentRoomId).emit('onNewLog', log);
    });

    socket.on('syncTogglePause', () => {
        if (!currentRoomId) return;
        const room = getOrCreateRoom(currentRoomId);
        if (room.gameState === "PLAYING") {
            room.gameState = "PAUSE";
        } else if (room.gameState === "PAUSE") {
            room.gameState = "PLAYING";
        }
        io.to(currentRoomId).emit('onGameStateChange', { state: room.gameState });
    });

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
        io.to(currentRoomId).emit('onScoreChange', data);
        const tName = data.scoringTeam === "BLUE" ? room.teamBlueName : room.teamRedName;
        const log = addLog(room, 'score', `🎉 [득점] ${tName} 팀 득점! (${room.scoreBlue} VS ${room.scoreRed})`);
        io.to(currentRoomId).emit('onNewLog', log);
    });

    socket.on('syncStartMiniGame', (data) => {
        if (!currentRoomId) return;
        const room = getOrCreateRoom(currentRoomId);
        
        // 📌 [버그 수정]: 이미 미니게임이 진행 중이거나 쿨타임 제한이 풀리지 않은 상태에서의 무분별한 4연속 격돌 차단
        const currentTime = Date.now();
        if (room.gameState === "MINIGAME" || currentTime < room.globalDefenseLockUntil) {
            return; 
        }

        if (room.miniGameTimerId) {
            clearTimeout(room.miniGameTimerId);
        }

        room.gameState = "MINIGAME";
        room.miniGameGauge = 25;
        room.activeDefender = { team: data.defTeam, id: data.defId };
        room.activeAttacker = { team: data.attTeam, id: data.attId };

        io.to(currentRoomId).emit('onStartMiniGame', {
            attTeam: data.attTeam,
            attId: data.attId,
            defTeam: data.defTeam,
            defId: data.defId,
            attackerColor: '#ffcc00',
            defenderColor: '#3498db'
        });

        // 타임아웃 타이머 스케줄 제어
        room.miniGameTimerId = setTimeout(() => {
            handleMiniGameTimeout(currentRoomId);
        }, 5000);
    });

    socket.on('syncMiniGameHit', (data) => {
        if (!currentRoomId) return;
        const room = roomsData[currentRoomId];
        if (!room || room.gameState !== "MINIGAME") return;

        if (data.role === "DEFENDER") room.miniGameGauge += 1;
        else if (data.role === "ATTACKER") room.miniGameGauge -= 1;

        if (room.miniGameGauge > 50) room.miniGameGauge = 50;
        if (room.miniGameGauge < 0) room.miniGameGauge = 0;

        io.to(currentRoomId).emit('onMiniGameGauge', room.miniGameGauge);
    });

    function handleMiniGameTimeout(roomId) {
        const room = roomsData[roomId];
        if (!room || room.gameState !== "MINIGAME") return;

        room.gameState = "PLAYING";
        room.globalDefenseLockUntil = Date.now() + 5000; // 확실한 5초 면제 선언

        if (room.miniGameGauge > 25) {
            room.ballState.holderTeam = room.activeDefender.team;
            room.ballState.holderId = room.activeDefender.id;
            room.ballState.isFlying = false;
            room.ballState.vx = 0;
            room.ballState.vy = 0;

            const log = addLog(room, 'defense', `디펜스 성공! 공을 스틸했습니다.`);
            io.to(roomId).emit('onNewLog', log);
            io.to(roomId).emit('onEndMiniGame', {
                isDefWin: true,
                holderTeam: room.activeDefender.team,
                holderId: room.activeDefender.id,
                globalDefenseLockUntil: room.globalDefenseLockUntil
            });
        } else {
            room.ballState.holderTeam = room.activeAttacker.team;
            room.ballState.holderId = room.activeAttacker.id;
            room.ballState.isFlying = false;

            const log = addLog(room, 'defense', `디펜스 실패! 공의 소유권을 유지합니다.`);
            io.to(roomId).emit('onNewLog', log);
            io.to(roomId).emit('onEndMiniGame', {
                isDefWin: false,
                holderTeam: room.activeAttacker.team,
                holderId: room.activeAttacker.id,
                globalDefenseLockUntil: room.globalDefenseLockUntil
            });
        }
        
        if (room.miniGameTimerId) {
            clearTimeout(room.miniGameTimerId);
            room.miniGameTimerId = null;
        }
    }

    socket.on('syncDirectorAuth', (data) => {
        if (!currentRoomId) return;
        const room = getOrCreateRoom(currentRoomId);
        room.directorName = data.name;
        room.directorToken = data.token;
        io.to(currentRoomId).emit('onDirectorAuthSuccess', data);
        const log = addLog(room, 'chat', `👑 [시스템] ${data.name} 님이 총감독으로 선임되었습니다.`);
        io.to(currentRoomId).emit('onNewLog', log);
    });

    socket.on('syncPlayerSkillChange', (data) => {
        if (!currentRoomId) return;
        const room = getOrCreateRoom(currentRoomId);
        const p = room.registeredOwners.find(o => o.team === data.team && o.id === data.id);
        if (p) {
            p.skillLevel = parseFloat(data.level);
            io.to(currentRoomId).emit('onInitRoomState', room);
            const log = addLog(room, 'chat', `⚡ [능력치 조정] ${p.ownerName} 선수의 경기력이 ${data.level}로 변경되었습니다.`);
            io.to(currentRoomId).emit('onNewLog', log);
        }
    });

    socket.on('sendDirectorChat', (text) => {
        if (!currentRoomId) return;
        const room = getOrCreateRoom(currentRoomId);
        const log = addLog(room, 'chat', `📢 [알림] ${text}`);
        io.to(currentRoomId).emit('onNewLog', log);
    });

    socket.on('syncClearLogs', () => {
        if (!currentRoomId) return;
        const room = getOrCreateRoom(currentRoomId);
        room.logs = [];
        io.to(currentRoomId).emit('onInitRoomState', room);
    });

    socket.on('disconnect', () => {
        if (currentRoomId && roomsData[currentRoomId]) {
            const room = roomsData[currentRoomId];
            const p = room.registeredOwners.find(o => o.socketId === socket.id);
            if (p) {
                // 끊겨도 시각적 잔상 고착 현상 제거용 로직 확장 가능
            }
        }
    });
});

const PORT = 3000;
server.listen(PORT, () => {
    console.log(`서버 오픈: http://localhost:${PORT}`);
});
