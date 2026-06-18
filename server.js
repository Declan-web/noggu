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
        room.ballState.x = data.x;
        room.ballState.y = data.y;
        room.ballState.vx = data.vx;
        room.ballState.vy = data.vy;
        room.ballState.isFlying = data.isFlying;
        room.ballState.holderId = data.holderId || null;
        room.ballState.holderTeam = data.holderTeam || null;
        room.ballState.lastShooterSkill = data.lastShooterSkill || 5.0;

        socket.to(currentRoomId).emit('onBallAction', data);
    });

    socket.on('syncMatchCapacity', (data) => {
        if (!currentRoomId) return;
        const room = getOrCreateRoom(currentRoomId);
        room.maxBluePlayers = data.blueMax;
        room.maxRedPlayers = data.redMax;
        io.to(currentRoomId).emit('onMatchCapacityChange', data);
    });

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
        const log = addLog(room, 'score', "시합이 시작되었습니다! 매치가 진행됩니다.");
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

    // 📌 [잔상 오류 완전 수정] 경기 리셋 시 방의 모든 메모리 구조와 타이머를 제거하고 클라이언트에 리셋 명령 강제 하향
    socket.on('syncResetMatch', () => {
        if (!currentRoomId) return;
        
        const room = roomsData[currentRoomId];
        if (room && room.miniGameTimerId) {
            clearTimeout(room.miniGameTimerId);
        }

        // 완벽하게 데이터를 밀어버려 같은 이름/비번 진입 잔상을 근본적으로 차단합니다.
        delete roomsData[currentRoomId];
        
        // 모든 클라이언트 측 브라우저 세션과 데이터 캐시를 하드 포맷하도록 강제 브로드캐스트
        io.to(currentRoomId).emit('onResetMatch');
    });

    socket.on('syncScore', (data) => {
        if (!currentRoomId) return;
        const room = getOrCreateRoom(currentRoomId);
        room.scoreBlue = data.blue;
        room.scoreRed = data.red;
        socket.to(currentRoomId).emit('onScoreUpdate', data);

        const targetTeamName = data.scoringTeam === "BLUE" ? room.teamBlueName : room.teamRedName;
        const log = addLog(room, 'score', `🎉 [득점] ${targetTeamName} 팀이 2점을 추가 달성했습니다! (${room.scoreBlue} VS ${room.scoreRed})`);
        io.to(currentRoomId).emit('onNewLog', log);
    });

    socket.on('syncUpdateSkillLevel', (data) => {
        if (!currentRoomId) return;
        const room = getOrCreateRoom(currentRoomId);
        const p = room.registeredOwners.find(o => o.team === data.team && o.id === data.id);
        if (p) {
            p.skillLevel = data.skillLevel;
            io.to(currentRoomId).emit('onUpdateSkillLevel', data);
        }
    });

    socket.on('syncRegisterDirector', (data) => {
        if (!currentRoomId) return;
        const room = getOrCreateRoom(currentRoomId);
        room.directorName = data.name;
        room.directorToken = data.token;
        
        io.to(currentRoomId).emit('onRegisterDirector', data);
        io.to(currentRoomId).emit('onInitRoomState', room);
    });

    // 📌 미니게임 개시 (5초 타임어택 결투 시스템 장착 및 골드/퍼플 콘셉트 동기화)
    socket.on('syncStartMiniGame', (data) => {
        if (!currentRoomId) return;
        const room = getOrCreateRoom(currentRoomId);
        
        // 혹시 작동 중이던 유령 타이머가 있다면 클리어
        if (room.miniGameTimerId) clearTimeout(room.miniGameTimerId);

        room.gameState = "MINIGAME";
        room.miniGameGauge = 25; // 중앙 정렬
        room.activeDefender = { team: data.defTeam, id: data.defId };
        room.activeAttacker = { team: data.attTeam, id: data.attId };
        
        // UI 연동용 색상 매칭 정보 주입 (공격=골드황금, 수비=퍼플보라)
        io.to(currentRoomId).emit('onStartMiniGame', {
            ...data,
            attackerColor: '#FFD700', // GOLD
            defenderColor: '#8A2BE2'  // PURPLE
        });

        // ⏱️ [5초 자동 만료 시스템 적용] 게이지 끝까지 안 채워도 5초 뒤 강제 판정
        room.miniGameTimerId = setTimeout(() => {
            handleMiniGameTimeout(currentRoomId);
        }, 5000);
    });

    // 미니게임 실시간 난타 스트로크 수신 루프
    socket.on('syncMiniGameHit', (role) => {
        if (!currentRoomId) return;
        const room = getOrCreateRoom(currentRoomId);
        if (room.gameState !== "MINIGAME") return;

        // 보라색 수비(DEFENDER)는 우측(+방향)으로, 황금색 공격(ATTACKER)은 좌측(-방향)으로 게이지를 밀어냅니다.
        if (role === "DEFENDER") {
            room.miniGameGauge += 1;
        } else if (role === "ATTACKER") {
            room.miniGameGauge -= 1;
        }

        // 게이지 상한선 제한 처리 (0 ~ 50 보정)
        if (room.miniGameGauge > 50) room.miniGameGauge = 50;
        if (room.miniGameGauge < 0) room.miniGameGauge = 0;

        io.to(currentRoomId).emit('onMiniGameGauge', room.miniGameGauge);
    });

    // 📌 [5초 만료 후 승자 판정 비즈니스 로직 연산 엔진]
    function handleMiniGameTimeout(roomId) {
        const room = roomsData[roomId];
        if (!room || room.gameState !== "MINIGAME") return;

        room.gameState = "PLAYING";
        room.globalDefenseLockUntil = Date.now() + 5000; // 개인기 면역 디폴트 부여

        // 판정 기준: 게이지가 초기값 25보다 크면 보라색 수비(DEFENDER) 승리, 작거나 같으면 황금색 공격(ATTACKER) 승리
        if (room.miniGameGauge > 25) {
            // 보라색 수비(DEFENDER) 승리 -> 공 스틸 탈환 성공
            room.ballState.holderTeam = room.activeDefender.team;
            room.ballState.holderId = room.activeDefender.id;
            room.ballState.isFlying = false;

            const log = addLog(room, 'defense', `🛡️ [시간 만료 판정] 수비진영(보라)의 압박 판정승! 공을 탈환했습니다.`);
            io.to(roomId).emit('onNewLog', log);
            io.to(roomId).emit('onEndMiniGame', { 
                isDefWin: true, 
                holderTeam: room.activeDefender.team, 
                holderId: room.activeDefender.id, 
                globalDefenseLockUntil: room.globalDefenseLockUntil 
            });
        } else {
            // 황금색 공격(ATTACKER) 승리 -> 가속 돌파 성공 및 소유권 보존
            room.ballState.holderTeam = room.activeAttacker.team;
            room.ballState.holderId = room.activeAttacker.id;
            room.ballState.isFlying = false;

            const log = addLog(room, 'defense', `⚡ [시간 만료 판정] 공격진영(황금)의 돌파 판정승! 돌파에 성공했습니다.`);
            io.to(roomId).emit('onNewLog', log);
            io.to(roomId).emit('onEndMiniGame', { 
                isDefWin: false, 
                holderTeam: room.activeAttacker.team, 
                holderId: room.activeAttacker.id, 
                globalDefenseLockUntil: room.globalDefenseLockUntil 
            });
        }
    }

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
        io.to(currentRoomId).emit('onClearLogs');
    });

    socket.on('disconnect', () => {});
});

app.use((req, res) => {
    sendIndexHtml(req, res);
});

const PORT = 3000;
server.listen(PORT, () => {
    console.log(`다들 모여 매치 코어 서버 연동 완료: http://localhost:${PORT}`);
});
