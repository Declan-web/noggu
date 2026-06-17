const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http);
const path = require('path');

app.use(express.static(path.join(__dirname, '')));

const rooms = {
    "0001": createNewRoom("0001"),
    "0002": createNewRoom("0002")
};

function createNewRoom(roomId) {
    return {
        roomId: roomId,
        scoreBlue: 0,
        scoreRed: 0,
        teamBlueName: "TEAM BLUE",
        teamRedName: "TEAM RED",
        maxBluePlayers: 5,
        maxRedPlayers: 5,
        gameState: "SETUP", // SETUP, PLAYING, MINIGAME, PAUSE
        directorName: null,
        directorToken: null,
        globalDefenseLockUntil: 0,
        registeredOwners: [],
        logs: [],
        miniGameGauge: 25, // 50칸 중 수비수 기준 지분 (25칸 시작)
        activeDefender: null,
        activeAttacker: null
    };
}

function getTimestamp() {
    const now = new Date();
    return now.toTimeString().split(' ')[0];
}

function addLogToRoom(room, type, message) {
    const logEntry = { timestamp: getTimestamp(), type: type, message: message };
    room.logs.push(logEntry);
    if (room.logs.length > 40) room.logs.shift();
    io.to(room.roomId).emit("onNewLog", logEntry);
}

io.on('connection', (socket) => {
    let currentRoomId = null;
    let authUserName = null;

    socket.on('joinRoom', (data) => {
        const roomId = data.roomId ? data.roomId.trim() : "";
        const userName = data.userName ? data.userName.trim() : "";
        const password = data.password ? data.password.trim() : "";

        if (roomId !== "0001" && roomId !== "0002") {
            socket.emit('authResult', { success: false, isAutoRefresh: data.isAutoRefresh, message: "존재하지 않는 경기 코드입니다." });
            return;
        }

        currentRoomId = roomId;
        authUserName = userName;
        socket.join(currentRoomId);

        const room = rooms[currentRoomId];
        let existingUser = room.registeredOwners.find(o => o.ownerName === userName);
        let myAssignedSlot = null;

        if (existingUser) {
            if (existingUser.password !== password) {
                socket.emit('authResult', { success: false, isAutoRefresh: data.isAutoRefresh, message: "이미 등록된 이름입니다. 비밀번호를 다시 확인하세요." });
                socket.leave(currentRoomId);
                currentRoomId = null;
                authUserName = null;
                return;
            }
            existingUser.socketId = socket.id;
            myAssignedSlot = { team: existingUser.team, id: existingUser.id };
            addLogToRoom(room, 'system', `[${userName}]님이 게임 세션을 복구(재접속)했습니다.`);
        }

        socket.emit('authResult', { success: true, isAutoRefresh: data.isAutoRefresh, myAssignedSlot: myAssignedSlot });

        socket.emit('onInitRoomState', {
            scoreBlue: room.scoreBlue, scoreRed: room.scoreRed,
            maxBluePlayers: room.maxBluePlayers, maxRedPlayers: room.maxRedPlayers,
            teamBlueName: room.teamBlueName, teamRedName: room.teamRedName,
            gameState: room.gameState, directorName: room.directorName, directorToken: room.directorToken,
            globalDefenseLockUntil: room.globalDefenseLockUntil, registeredOwners: room.registeredOwners,
            logs: room.logs, miniGameGauge: room.miniGameGauge,
            activeDefender: room.activeDefender, activeAttacker: room.activeAttacker
        });
    });

    socket.on('syncPlayerMove', (data) => {
        if (!currentRoomId || !rooms[currentRoomId]) return;
        const room = rooms[currentRoomId];
        if (room.gameState === "MINIGAME") return;

        const p = room.registeredOwners.find(o => o.team === data.team && o.id === data.id);
        if (p) { p.x = data.x; p.y = data.y; p.angle = data.angle; }
        socket.to(currentRoomId).emit('onPlayerMove', data);
    });

    socket.on('syncBallAction', (data) => {
        if (!currentRoomId) return;
        socket.to(currentRoomId).emit('onBallAction', data);
    });

    socket.on('syncRegisterDirector', (data) => {
        if (!currentRoomId || !rooms[currentRoomId]) return;
        const room = rooms[currentRoomId];
        if (!room.directorToken || room.directorToken === data.token) {
            room.directorName = data.name; room.directorToken = data.token;
            io.to(currentRoomId).emit('onRegisterDirector', { directorName: room.directorName, directorToken: room.directorToken });
            addLogToRoom(room, 'system', `[${data.name}]님이 경기 감독관으로 부임했습니다.`);
        }
    });

    socket.on('syncRegisterOwner', (data) => {
        if (!currentRoomId || !rooms[currentRoomId]) return;
        const room = rooms[currentRoomId];
        room.registeredOwners = room.registeredOwners.filter(o => !(o.team === data.team && o.id === data.id));
        if (data.ownerName !== "") {
            room.registeredOwners.push({
                team: data.team, id: data.id, ownerName: data.ownerName, password: data.password,
                socketId: socket.id, skillLevel: 5.0, x: data.x || 0, y: data.y || 0, angle: data.angle || 0
            });
            addLogToRoom(room, 'system', `[${data.team}] ${data.id}번에 ${data.ownerName}님이 등록되었습니다.`);
        }
        io.to(currentRoomId).emit('onRegisterOwner', data);
    });

    socket.on('syncUpdateSkillLevel', (data) => {
        if (!currentRoomId || !rooms[currentRoomId]) return;
        const room = rooms[currentRoomId];
        const p = room.registeredOwners.find(o => o.team === data.team && o.id === data.id);
        if (p) {
            p.skillLevel = data.skillLevel;
            io.to(currentRoomId).emit('onUpdateSkillLevel', data);
            addLogToRoom(room, 'system', `감독 권한으로 [${p.ownerName}]의 경기력이 ${data.skillLevel.toFixed(1)}v로 변경되었습니다.`);
        }
    });

    socket.on('syncMatchCapacity', (data) => {
        if (!currentRoomId || !rooms[currentRoomId]) return;
        const room = rooms[currentRoomId];
        room.maxBluePlayers = data.blueMax; room.maxRedPlayers = data.redMax;
        io.to(currentRoomId).emit('onMatchCapacityChange', data);
    });

    socket.on('syncLiveTeamName', (data) => {
        if (!currentRoomId || !rooms[currentRoomId]) return;
        const room = rooms[currentRoomId];
        if (data.team === "BLUE") room.teamBlueName = data.name; else room.teamRedName = data.name;
        socket.to(currentRoomId).emit('onLiveTeamName', data);
    });

    socket.on('syncStartGame', (data) => {
        if (!currentRoomId || !rooms[currentRoomId]) return;
        const room = rooms[currentRoomId];
        room.gameState = "PLAYING";
        room.teamBlueName = data.teamBlueName; room.teamRedName = data.teamRedName;
        room.maxBluePlayers = data.maxBluePlayers; room.maxRedPlayers = data.maxRedPlayers;
        room.globalDefenseLockUntil = 0;
        io.to(currentRoomId).emit('onStartGame', data);
        addLogToRoom(room, 'system', `경기가 공식적으로 개시되었습니다!`);
    });

    socket.on('syncTogglePause', () => {
        if (!currentRoomId || !rooms[currentRoomId]) return;
        const room = rooms[currentRoomId];
        room.gameState = (room.gameState === "PLAYING") ? "PAUSE" : "PLAYING";
        io.to(currentRoomId).emit('onGameStateChange', { state: room.gameState });
        addLogToRoom(room, 'system', `경기가 일시 정지되거나 해제되었습니다.`);
    });

    socket.on('syncResetMatch', () => {
        if (!currentRoomId || !rooms[currentRoomId]) return;
        rooms[currentRoomId] = createNewRoom(currentRoomId);
        io.to(currentRoomId).emit('onResetMatch');
    });

    socket.on('syncScore', (data) => {
        if (!currentRoomId || !rooms[currentRoomId]) return;
        const room = rooms[currentRoomId];
        room.scoreBlue = data.blue; room.scoreRed = data.red;
        socket.to(currentRoomId).emit('onScoreUpdate', data);
        const currentScoringTeamName = data.scoringTeam === "BLUE" ? room.teamBlueName : room.teamRedName;
        addLogToRoom(room, 'score', `${currentScoringTeamName}팀 득점! [${room.scoreBlue} : ${room.scoreRed}]`);
    });

    socket.on('syncStartMiniGame', (data) => {
        if (!currentRoomId || !rooms[currentRoomId]) return;
        const room = rooms[currentRoomId];
        room.gameState = "MINIGAME";
        room.miniGameGauge = 25; // 50 총량 중 서로 25씩 똑같이 지니고 시작
        room.activeDefender = { team: data.defTeam, id: data.defId };
        room.activeAttacker = { team: data.attTeam, id: data.attId };
        io.to(currentRoomId).emit('onStartMiniGame', data);
    });

    socket.on('syncMiniGameHit', (role) => {
        if (!currentRoomId || !rooms[currentRoomId]) return;
        const room = rooms[currentRoomId];
        if (room.gameState !== "MINIGAME") return;

        if (role === "DEFENDER") {
            room.miniGameGauge += 1; // 수비수 진영 게이지 획득
            if (room.miniGameGauge > 50) room.miniGameGauge = 50;
        } else if (role === "ATTACKER") {
            room.miniGameGauge -= 1; // 공격수 진영 게이지 획득 (수비수 몫 차감)
            if (room.miniGameGauge < 0) room.miniGameGauge = 0;
        }
        io.to(currentRoomId).emit('onMiniGameGauge', room.miniGameGauge);
    });

    socket.on('syncEndMiniGame', (resultData) => {
        if (!currentRoomId || !rooms[currentRoomId]) return;
        const room = rooms[currentRoomId];
        room.gameState = "PLAYING";
        room.globalDefenseLockUntil = Date.now() + 5000; 

        resultData.globalDefenseLockUntil = room.globalDefenseLockUntil;
        io.to(currentRoomId).emit('onEndMiniGame', resultData);

        const defObj = room.registeredOwners.find(o => o.team === resultData.defTeam && o.id === resultData.defId);
        const attObj = room.registeredOwners.find(o => o.team === resultData.attTeam && o.id === resultData.attId);
        const defenderName = defObj ? defObj.ownerName : "수비수";
        const attackerName = attObj ? attObj.ownerName : "공격수";

        if (resultData.isDefWin) {
            addLogToRoom(room, 'defense', `[${defenderName}] 수비 성공! (${resultData.defGauge}칸 확보) 공을 탈환합니다.`);
        } else {
            addLogToRoom(room, 'defense', `[${attackerName}] 방어 성공! (${resultData.attGauge}칸 확보) 돌파를 이어갑니다.`);
        }
        
        room.activeDefender = null;
        room.activeAttacker = null;
    });

    socket.on('sendDirectorChat', (text) => {
        if (!currentRoomId || !rooms[currentRoomId]) return;
        const room = rooms[currentRoomId];
        const name = room.directorName || "감독";
        addLogToRoom(room, 'chat', `[${name}]: ${text}`);
    });

    socket.on('syncClearLogs', () => {
        if (!currentRoomId || !rooms[currentRoomId]) return;
        rooms[currentRoomId].logs = [];
        io.to(currentRoomId).emit('onClearLogs');
    });

    socket.on('disconnect', () => {
        if (currentRoomId && rooms[currentRoomId] && authUserName) {
            const room = rooms[currentRoomId];
            addLogToRoom(room, 'system', `유저 [${authUserName}]의 연결이 일시단절되었습니다.`);
        }
    });
});

const PORT = 3000;
http.listen(PORT, () => {
    console.log(`농구 미니게임 서버가 포트 ${PORT}에서 정상 가동 중입니다.`);
});
