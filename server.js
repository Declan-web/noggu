const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    }
});

const PORT = process.env.PORT || 3000;

app.get('/', (req, res) => {
    res.sendFile(__dirname + '/index.html');
});

// 자유로운 인원 매치를 위해 최대 5대5 공간을 항상 열어둡니다.
let roomState = {
    gameState: "SETUP",
    teamBlueName: "TEAM BLUE",
    teamRedName: "TEAM RED",
    scoreBlue: 0,
    scoreRed: 0,
    registeredOwners: [],
    directorName: null, 
    directorSocketId: null, 
    logs: [] 
};

let prePauseState = "SETUP";

function addServerLog(message, type = "system") {
    const logEntry = {
        id: Date.now() + Math.random().toString(36).substr(2, 5),
        timestamp: new Date().toLocaleTimeString('ko-KR', { hour12: false }),
        message: message,
        type: type 
    };
    roomState.logs.push(logEntry);
    if (roomState.logs.length > 100) roomState.logs.shift();
    io.emit('onNewLog', logEntry);
}

io.on('connection', (socket) => {
    console.log(`클라이언트 소켓 연결 완료: ${socket.id}`);

    socket.emit('onInitRoomState', roomState);

    socket.on('syncPlayerMove', (data) => {
        socket.broadcast.emit('onPlayerMove', data);
    });

    socket.on('syncBallLocation', (data) => {
        socket.broadcast.emit('onBallLocation', data);
    });

    socket.on('syncBallAction', (data) => {
        io.emit('onBallAction', data);
    });

    socket.on('syncRegisterOwner', (data) => {
        const exists = roomState.registeredOwners.find(p => p.team === data.team && p.id === data.id);
        if (!exists) {
            data.skillLevel = 5.0;
            data.socketId = socket.id; 
            roomState.registeredOwners.push(data);
        }
        const teamMark = data.team === 'BLUE' ? '[BLUE]' : '[RED]';
        addServerLog(`[참가] ${teamMark} ${data.ownerName} 유저가 ${data.id}번 캐릭터를 선택했습니다.`);
        io.emit('onRegisterOwner', data); 
    });

    socket.on('syncUpdateSkillLevel', (data) => {
        const target = roomState.registeredOwners.find(p => p.team === data.team && p.id === data.id);
        if (target) {
            target.skillLevel = parseFloat(data.skillLevel);
            const teamMark = target.team === 'BLUE' ? '[BLUE]' : '[RED]';
            addServerLog(`[관리] 감독이 ${teamMark} ${target.ownerName} 선수의 경기력을 ${target.skillLevel.toFixed(1)}v로 조정했습니다.`);
        }
        io.emit('onUpdateSkillLevel', data);
    });

    socket.on('syncLiveTeamName', (data) => {
        if (data.team === "BLUE") {
            roomState.teamBlueName = data.name;
        } else if (data.team === "RED") {
            roomState.teamRedName = data.name;
        }
        socket.broadcast.emit('onLiveTeamName', data);
    });

    socket.on('syncRegisterDirector', (name) => {
        roomState.directorName = name;
        roomState.directorSocketId = socket.id;
        io.emit('onRegisterDirector', {
            directorName: roomState.directorName,
            directorSocketId: roomState.directorSocketId
        });
    });

    socket.on('syncStartGame', (data) => {
        roomState.gameState = "PLAYING";
        roomState.teamBlueName = data.teamBlueName;
        roomState.teamRedName = data.teamRedName;
        addServerLog(`[시작] 경기가 시작되었습니다! (${data.teamBlueName} VS ${data.teamRedName})`, "system");
        io.emit('onStartGame', data);
    });

    socket.on('syncResetMatch', () => {
        roomState.gameState = "SETUP";
        roomState.scoreBlue = 0;
        roomState.scoreRed = 0;
        roomState.registeredOwners = [];
        roomState.logs = [];
        prePauseState = "SETUP";
        io.emit('onResetMatch');
        addServerLog(`[초기화] 매치가 전면 초기화되었습니다. 캐릭터를 다시 선택해주세요.`);
    });

    socket.on('syncClearLogs', () => {
        if (socket.id === roomState.directorSocketId) {
            roomState.logs = [];
            io.emit('onClearLogs');
            addServerLog(`[알림] 감독에 의해 로그 창이 초기화되었습니다.`);
        }
    });

    socket.on('syncTogglePause', () => {
        if (roomState.gameState === "PAUSE") {
            roomState.gameState = prePauseState;
            addServerLog(`[재개] 일시정지가 해제되어 경기를 다시 진행합니다.`);
            io.emit('onTogglePause', { gameState: roomState.gameState, isPaused: false });
        } else {
            prePauseState = roomState.gameState;
            roomState.gameState = "PAUSE";
            addServerLog(`[정지] 감독에 의해 경기가 일시정지 되었습니다.`);
            io.emit('onTogglePause', { gameState: "PAUSE", isPaused: true });
        }
    });

    socket.on('syncScore', (data) => {
        roomState.scoreBlue = data.blue;
        roomState.scoreRed = data.red;
        const teamMark = data.scoringTeam === 'BLUE' ? '[BLUE] ' + roomState.teamBlueName : '[RED] ' + roomState.teamRedName;
        addServerLog(`[득점] ${teamMark} 득점 성공! (현재 스코어 BLUE ${data.blue} : RED ${data.red})`, "score");
        socket.broadcast.emit('onScore', data);
    });

    socket.on('syncStartDefense', (data) => {
        roomState.gameState = "MINIGAME";
        const defMark = data.defTeam === 'BLUE' ? '[BLUE]' : '[RED]';
        const attMark = data.attTeam === 'BLUE' ? '[BLUE]' : '[RED]';
        addServerLog(`[디펜스] ${defMark} 수비수(${data.defId}번)가 ${attMark} 공격수(${data.attId}번)에게 클로즈 디펜스를 시도합니다!`, "defense");
        io.emit('onStartDefense', data);
    });

    socket.on('syncMiniGameTick', (data) => {
        socket.broadcast.emit('onMiniGameTick', data);
    });

    socket.on('syncMiniGameHit', (gauge) => {
        io.emit('onMiniGameHit', gauge);
    });

    socket.on('syncEndMiniGame', (data) => {
        if (roomState.gameState !== "MINIGAME") return; 
        roomState.gameState = "PLAYING";
        
        if (data.isDefWin) {
            addServerLog(`[디펜스 성공] 수비가 성공하여 공을 스틸했습니다!`, "defense");
        } else {
            addServerLog(`[디펜스 실패] 공격수가 수비를 제치고 돌파에 성공했습니다!`, "defense");
        }
        io.emit('onEndMiniGame', data.isDefWin);
    });

    socket.on('sendDirectorChat', (msg) => {
        const name = roomState.directorName || "미지정";
        addServerLog(`[감독 ${name}] ${msg}`, "chat");
    });

    socket.on('disconnect', () => {
        if (socket.id === roomState.directorSocketId) {
            addServerLog(`[공지] 감독 [${roomState.directorName}] 님이 퇴장하여 감독 직위가 공석이 되었습니다.`);
            roomState.directorName = null;
            roomState.directorSocketId = null;
            io.emit('onRegisterDirector', { directorName: null, directorSocketId: null });
        }

        const leftPlayer = roomState.registeredOwners.find(p => p.socketId === socket.id);
        if (leftPlayer) {
            const teamMark = leftPlayer.team === 'BLUE' ? '[BLUE]' : '[RED]';
            addServerLog(`[퇴장] ${teamMark} ${leftPlayer.ownerName} 유저가 연결을 해제했습니다.`);
        }
        roomState.registeredOwners = roomState.registeredOwners.filter(p => p.socketId !== socket.id);
        io.emit('onRoomOwnersUpdate', roomState.registeredOwners);
    });
});

http.listen(PORT, () => {
    console.log(`서버 정상 기동 중. 포트번호: ${PORT}`);
});
