const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = 3000;

app.use(express.static(path.join(__dirname)));

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

const rooms = {};

function createInitialRoomState() {
    return {
        gameState: "SETUP",
        scoreBlue: 0,
        scoreRed: 0,
        teamBlueName: "TEAM BLUE",
        teamRedName: "TEAM RED",
        maxBluePlayers: 5,
        maxRedPlayers: 5,
        registeredOwners: [],
        directorName: null,
        directorToken: null,
        logs: [],
        miniGameGauge: 25,
        miniGameTimer: 0,
        activeDefender: null,
        activeAttacker: null,
        globalDefenseLockUntil: 0
    };
}

function addLogToRoom(room, message, type) {
    const filterPattern = /\[[^\]]*감독[^\]]*\]|감독|경기력/;
    if (filterPattern.test(message)) {
        return;
    }

    const now = new Date();
    const timestamp = now.toTimeString().split(' ')[0];
    const logEntry = { timestamp, message, type };
    
    room.logs.push(logEntry);
    if (room.logs.length > 40) {
        room.logs.shift();
    }
    return logEntry;
}

io.on('connection', (socket) => {
    let currentRoomId = null;
    let myRegisteredUser = null;

    socket.on('joinRoom', (data) => {
        const { roomId, userName, password, isAutoRefresh } = data;
        
        if (!roomId || !userName) {
            socket.emit('authResult', { success: false, message: "올바르지 않은 접근입니다." });
            return;
        }

        currentRoomId = roomId;
        if (!rooms[currentRoomId]) {
            rooms[currentRoomId] = createInitialRoomState();
        }

        const room = rooms[currentRoomId];
        socket.join(currentRoomId);

        let existingUser = room.registeredOwners.find(p => p.ownerName === userName);
        
        if (existingUser) {
            existingUser.socketId = socket.id;
            myRegisteredUser = existingUser;
        }

        socket.emit('authResult', { success: true, isAutoRefresh });
        
        socket.emit('onInitRoomState', {
            gameState: room.gameState,
            scoreBlue: room.scoreBlue,
            scoreRed: room.scoreRed,
            teamBlueName: room.teamBlueName,
            teamRedName: room.teamRedName,
            maxBluePlayers: room.maxBluePlayers,
            maxRedPlayers: room.maxRedPlayers,
            registeredOwners: room.registeredOwners,
            directorName: room.directorName,
            directorToken: room.directorToken,
            logs: room.logs,
            miniGameGauge: room.miniGameGauge,
            activeDefender: room.activeDefender,
            activeAttacker: room.activeAttacker,
            globalDefenseLockUntil: room.globalDefenseLockUntil
        });
    });

    socket.on('syncRegisterOwner', (data) => {
        if (!currentRoomId || !rooms[currentRoomId]) return;
        const room = rooms[currentRoomId];
        
        const isAlreadyRegistered = room.registeredOwners.some(p => p.ownerName === data.ownerName);
        if (isAlreadyRegistered) return;

        const newPlayer = {
            team: data.team,
            id: parseInt(data.id),
            ownerName: data.ownerName,
            socketId: socket.id,
            skillLevel: 5.0,
            x: data.x,
            y: data.y,
            angle: data.angle
        };

        room.registeredOwners.push(newPlayer);
        myRegisteredUser = newPlayer;

        const logEntry = addLogToRoom(room, `${data.ownerName} 유저가 [${data.team}] ${data.id}번 선수로 코트에 입장했습니다.`, "chat");
        
        io.to(currentRoomId).emit('onRegisterOwner', data);
        if (logEntry) io.to(currentRoomId).emit('onNewLog', logEntry);
    });

    socket.on('syncRegisterDirector', (data) => {
        if (!currentRoomId || !rooms[currentRoomId]) return;
        const room = rooms[currentRoomId];

        room.directorName = data.name;
        room.directorToken = data.token;

        const logEntry = addLogToRoom(room, `[시스템] ${data.name} 님이 총괄 감독 권한을 획득했습니다.`, "chat");

        io.to(currentRoomId).emit('onRegisterDirector', {
            directorName: room.directorName,
            directorToken: room.directorToken
        });
        if (logEntry) io.to(currentRoomId).emit('onNewLog', logEntry);
    });

    socket.on('syncMatchCapacity', (data) => {
        if (!currentRoomId || !rooms[currentRoomId]) return;
        const room = rooms[currentRoomId];

        room.maxBluePlayers = data.blueMax;
        room.maxRedPlayers = data.redMax;

        room.registeredOwners = room.registeredOwners.filter(p => {
            if (p.team === "BLUE" && p.id > room.maxBluePlayers) return false;
            if (p.team === "RED" && p.id > room.maxRedPlayers) return false;
            return true;
        });

        io.to(currentRoomId).emit('onMatchCapacityChange', data);
    });

    socket.on('syncLiveTeamName', (data) => {
        if (!currentRoomId || !rooms[currentRoomId]) return;
        const room = rooms[currentRoomId];

        if (data.team === "BLUE") {
            room.teamBlueName = data.name;
        } else {
            room.teamRedName = data.name;
        }

        io.to(currentRoomId).emit('onLiveTeamName', data);
    });

    socket.on('syncStartGame', (data) => {
        if (!currentRoomId || !rooms[currentRoomId]) return;
        const room = rooms[currentRoomId];

        room.gameState = "PLAYING";
        room.teamBlueName = data.teamBlueName;
        room.teamRedName = data.teamRedName;
        room.maxBluePlayers = data.maxBluePlayers;
        room.maxRedPlayers = data.maxRedPlayers;
        room.globalDefenseLockUntil = 0;

        const logEntry = addLogToRoom(room, "시작 신호가 울렸습니다! 경기를 시작합니다.", "chat");

        io.to(currentRoomId).emit('onStartGame', data);
        if (logEntry) io.to(currentRoomId).emit('onNewLog', logEntry);
    });

    socket.on('syncTogglePause', () => {
        if (!currentRoomId || !rooms[currentRoomId]) return;
        const room = rooms[currentRoomId];

        if (room.gameState === "PLAYING") {
            room.gameState = "PAUSE";
        } else if (room.gameState === "PAUSE") {
            room.gameState = "PLAYING";
        }

        io.to(currentRoomId).emit('onGameStateChange', { state: room.gameState });
    });

    socket.on('syncPlayerMove', (data) => {
        if (!currentRoomId || !rooms[currentRoomId]) return;
        const room = rooms[currentRoomId];

        const p = room.registeredOwners.find(o => o.team === data.team && o.id === data.id);
        if (p) {
            p.x = data.x;
            p.y = data.y;
            p.angle = data.angle;
            socket.to(currentRoomId).emit('onPlayerMove', data);
        }
    });

    socket.on('syncBallAction', (data) => {
        if (!currentRoomId || !rooms[currentRoomId]) return;
        socket.to(currentRoomId).emit('onBallAction', data);
    });

    socket.on('syncScore', (data) => {
        if (!currentRoomId || !rooms[currentRoomId]) return;
        const room = rooms[currentRoomId];

        room.scoreBlue = data.blue;
        room.scoreRed = data.red;

        const scoringTeamName = data.scoringTeam === "BLUE" ? room.teamBlueName : room.teamRedName;
        const logEntry = addLogToRoom(room, `🎉 슛 성공! [${scoringTeamName}]팀이 2점을 획득했습니다.`, "score");

        io.to(currentRoomId).emit('onScoreUpdate', { blue: room.scoreBlue, red: room.scoreRed });
        if (logEntry) io.to(currentRoomId).emit('onNewLog', logEntry);
    });

    socket.on('syncUpdateSkillLevel', (data) => {
        if (!currentRoomId || !rooms[currentRoomId]) return;
        const room = rooms[currentRoomId];

        const p = room.registeredOwners.find(o => o.team === data.team && o.id === data.id);
        if (p) {
            p.skillLevel = parseFloat(data.skillLevel);
            
            const logEntry = addLogToRoom(room, `[관리] [${data.team}] ${p.ownerName} 선수의 경기력이 ${p.skillLevel.toFixed(1)} 스케일로 조정되었습니다.`, "chat");
            
            io.to(currentRoomId).emit('onUpdateSkillLevel', data);
            if (logEntry) io.to(currentRoomId).emit('onNewLog', logEntry);
        }
    });

    socket.on('syncStartMiniGame', (data) => {
        if (!currentRoomId || !rooms[currentRoomId]) return;
        const room = rooms[currentRoomId];

        if (Date.now() < room.globalDefenseLockUntil) return;

        room.gameState = "MINIGAME";
        room.miniGameGauge = 25;
        room.miniGameTimer = 5.0; // 감독 유무 상관없이 무조건 5초 백엔드 가동
        
        room.activeDefender = { team: data.defTeam, id: data.defId };
        room.activeAttacker = { team: data.attTeam, id: data.attId };

        const defUser = room.registeredOwners.find(o => o.team === data.defTeam && o.id === data.defId);
        const attUser = room.registeredOwners.find(o => o.team === data.attTeam && o.id === data.attId);
        const defName = defUser ? defUser.ownerName : `선수 ${data.defId}`;
        const attName = attUser ? attUser.ownerName : `선수 ${data.attId}`;

        const logEntry = addLogToRoom(room, `🔥 [${defName}] 대 [${attName}] 디펜스 경합 경기가 선언되었습니다! (5초간 연타)`, "defense");

        io.to(currentRoomId).emit('onStartMiniGame', data);
        if (logEntry) io.to(currentRoomId).emit('onNewLog', logEntry);
    });

    socket.on('syncMiniGameHit', (role) => {
        if (!currentRoomId || !rooms[currentRoomId]) return;
        const room = rooms[currentRoomId];

        if (room.gameState !== "MINIGAME") return;

        // 게이지 방향 정의: 수비가 성공하면 게이지 증가(+), 공격이 수비 뚫으면 게이지 감소(-)
        if (role === "DEFENDER") {
            room.miniGameGauge += 1;
        } else if (role === "ATTACKER") {
            room.miniGameGauge -= 1;
        }

        if (room.miniGameGauge < 1) room.miniGameGauge = 1;
        if (room.miniGameGauge > 49) room.miniGameGauge = 49;

        io.to(currentRoomId).emit('onMiniGameGauge', room.miniGameGauge);
    });

    socket.on('syncEndMiniGame', (data) => {
        if (!currentRoomId || !rooms[currentRoomId]) return;
        const room = rooms[currentRoomId];

        room.gameState = "PLAYING";
        room.globalDefenseLockUntil = Date.now() + 5000;

        const defUser = room.registeredOwners.find(o => o.team === room.activeDefender.team && o.id === room.activeDefender.id);
        const attUser = room.registeredOwners.find(o => o.team === room.activeAttacker.team && o.id === room.activeAttacker.id);
        const defName = defUser ? defUser.ownerName : "수비수";
        const attName = attUser ? attUser.ownerName : "공격수";

        let message = "";
        if (data.isDefWin) {
            message = `🛡 수비 성공! [${defName}] 선수가 공을 빼앗아 가로챘습니다. (수비 득표: ${data.defGauge} vs 공격 득표: ${data.attGauge})`;
        } else {
            message = `⚡ 수비 실패! [${attName}] 선수가 철벽 방어를 뚫고 드라이브를 유지합니다. (수비 득표: ${data.defGauge} vs 공격 득표: ${data.attGauge})`;
        }

        const logEntry = addLogToRoom(room, message, "defense");
        data.globalDefenseLockUntil = room.globalDefenseLockUntil;
        
        io.to(currentRoomId).emit('onEndMiniGame', data);
        if (logEntry) io.to(currentRoomId).emit('onNewLog', logEntry);

        room.activeDefender = null;
        room.activeAttacker = null;
    });

    socket.on('sendDirectorChat', (text) => {
        if (!currentRoomId || !rooms[currentRoomId]) return;
        const room = rooms[currentRoomId];

        const logEntry = addLogToRoom(room, `💬 [공지] ${text}`, "chat");
        if (logEntry) io.to(currentRoomId).emit('onNewLog', logEntry);
    });

    socket.on('syncClearLogs', () => {
        if (!currentRoomId || !rooms[currentRoomId]) return;
        const room = rooms[currentRoomId];
        room.logs = [];
        io.to(currentRoomId).emit('onClearLogs');
    });

    socket.on('syncResetMatch', () => {
        if (!currentRoomId || !rooms[currentRoomId]) return;
        rooms[currentRoomId] = createInitialRoomState();
        io.to(currentRoomId).emit('onResetMatch');
    });

    socket.on('disconnect', () => {
        if (currentRoomId && rooms[currentRoomId] && myRegisteredUser) {
            const room = rooms[currentRoomId];
            room.registeredOwners = room.registeredOwners.filter(p => p.socketId !== socket.id);
            
            const logEntry = addLogToRoom(room, `${myRegisteredUser.ownerName} 선수가 경기장망에서 나갔습니다.`, "chat");
            
            io.to(currentRoomId).emit('onRegisterOwner', {
                team: myRegisteredUser.team,
                id: myRegisteredUser.id,
                ownerName: ""
            });
            if (logEntry) io.to(currentRoomId).emit('onNewLog', logEntry);
        }
    });
});

// 감독 사이트 브라우징 여부와 관계없이 독자 구동되는 서버 루프 엔진
setInterval(() => {
    Object.keys(rooms).forEach(roomId => {
        const room = rooms[roomId];
        if (room.gameState === "MINIGAME") {
            room.miniGameTimer -= 0.05; 
            if (room.miniGameTimer <= 0) {
                const defGauge = room.miniGameGauge;
                const attGauge = 50 - room.miniGameGauge;
                let isDefWin = defGauge > attGauge;

                if (defGauge === attGauge) {
                    isDefWin = Math.random() < 0.5;
                }

                room.gameState = "PLAYING";
                room.globalDefenseLockUntil = Date.now() + 5000;

                const defUser = room.registeredOwners.find(o => o.team === room.activeDefender.team && o.id === room.activeDefender.id);
                const attUser = room.registeredOwners.find(o => o.team === room.activeAttacker.team && o.id === room.activeAttacker.id);
                const defName = defUser ? defUser.ownerName : "수비수";
                const attName = attUser ? attUser.ownerName : "공격수";

                let message = "";
                let holderId = null;
                let holderTeam = null;

                if (isDefWin) {
                    message = `🛡 수비 성공! [${defName}] 선수가 공을 빼앗아 가로챘습니다. (수비 득표: ${defGauge} vs 공격 득표: ${attGauge})`;
                    holderId = room.activeDefender.id;
                    holderTeam = room.activeDefender.team;
                } else {
                    message = `⚡ 수비 실패! [${attName}] 선수가 철벽 방어를 뚫고 드라이브를 유지합니다. (수비 득표: ${defGauge} vs 공격 득표: ${attGauge})`;
                    holderId = room.activeAttacker.id;
                    holderTeam = room.activeAttacker.team;
                }

                const logEntry = addLogToRoom(room, message, "defense");

                io.to(roomId).emit('onEndMiniGame', {
                    isDefWin,
                    holderId,
                    holderTeam,
                    defGauge,
                    attGauge,
                    globalDefenseLockUntil: room.globalDefenseLockUntil
                });
                
                if (logEntry) io.to(roomId).emit('onNewLog', logEntry);

                room.activeDefender = null;
                room.activeAttacker = null;
            }
        }
    });
}, 50);

server.listen(PORT, () => {
    console.log(`Basketball Multi-Session Server running on http://localhost:${PORT}`);
});
