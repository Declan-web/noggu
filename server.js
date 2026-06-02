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

// 방 상태 구조 관리
let roomState = {
    gameState: "SETUP",
    teamBlueName: "TEAM BLUE",
    teamRedName: "TEAM RED",
    maxBluePlayers: 5,
    maxRedPlayers: 5,
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
        const p = roomState.registeredOwners.find(o => o.team === data.team && o.id === data.id);
        if (p) {
            p.x = data.x;
            p.y = data.y;
        }
        socket.broadcast.emit('onPlayerMove', data);
    });

    socket.on('syncBallLocation', (data) => {
        socket.broadcast.emit('onBallLocation', data);
    });

    socket.on('syncBallAction', (data) => {
        io.emit('onBallAction', data);
    });

    socket.on('syncMatchCapacity', (data) => {
        roomState.maxBluePlayers = parseInt(data.blueMax) || 5;
        roomState.maxRedPlayers = parseInt(data.redMax) || 5;
        socket.broadcast.emit('onMatchCapacityChange', data);
    });

    socket.on('syncRegisterOwner', (data) => {
        const exists = roomState.registeredOwners.find(p => p.team === data.team && p.id === data.id);
        if (!exists) {
            data.skillLevel = 5.0;
            data.socketId = socket.id; 
            roomState.registeredOwners.push(data);
        } else {
            exists.ownerName = data.ownerName;
            exists.socketId = socket.id;
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
        addServerLog(`[임명] [${name}] 님이 본 경기의 공식 감독관 권한을 승인받았습니다.`, "system");
        io.emit('onRegisterDirector', { directorName: name, directorSocketId: socket.id });
    });

    socket.on('syncClearLogs', () => {
        roomState.logs = [];
        io.emit('onClearLogs');
        addServerLog(`[알림] 감독에 의해 전체 경기 타임라인 로그가 초기화되었습니다.`, "system");
    });

    socket.on('syncStartGame', (data) => {
        roomState.gameState = "PLAYING";
        roomState.teamBlueName = data.teamBlueName;
        roomState.teamRedName = data.teamRedName;
        roomState.maxBluePlayers = data.maxBluePlayers;
        roomState.maxRedPlayers = data.maxRedPlayers;
        addServerLog(`🏁 [경기 개시] 경기 감독관의 지시 하에 매치가 정식으로 시작되었습니다! 화이팅!`, "score");
        io.emit('onStartGame', data);
    });

    socket.on('syncTogglePause', () => {
        if (roomState.gameState === "PAUSE") {
            roomState.gameState = prePauseState;
            addServerLog(`▶ [경기 재개] 일시정지가 해제되었습니다. 경기를 계속 진행합니다.`, "system");
        } else {
            prePauseState = roomState.gameState;
            roomState.gameState = "PAUSE";
            addServerLog(`⏸ [경기 중단] 감독 권한으로 경기가 일시 정지되었습니다.`, "system");
        }
        io.emit('onGameStateChange', { state: roomState.gameState });
    });

    socket.on('syncResetMatch', () => {
        roomState.gameState = "SETUP";
        roomState.scoreBlue = 0;
        roomState.scoreRed = 0;
        roomState.registeredOwners = [];
        roomState.logs = [];
        io.emit('onResetMatch');
        addServerLog(`🔄 [새 경기 준비] 경기가 완전히 리셋되었습니다. 대기실에서 캐릭터를 다시 골라주세요.`, "system");
    });

    socket.on('syncScore', (data) => {
        roomState.scoreBlue = data.blue;
        roomState.scoreRed = data.red;
        
        const currentTeamName = data.scoringTeam === "BLUE" ? roomState.teamBlueName : roomState.teamRedName;
        addServerLog(`⚽ [득점] ${currentTeamName} 팀이 골을 성공시키며 2점을 획득했습니다! (${roomState.scoreBlue} VS ${roomState.scoreRed})`, "score");
        io.emit('onScoreUpdate', data);
    });

    socket.on('syncStartMiniGame', (data) => {
        roomState.gameState = "MINIGAME";
        io.emit('onStartMiniGame', data);
    });

    socket.on('syncMiniGameGauge', (gauge) => {
        io.emit('onMiniGameGauge', gauge);
    });

    socket.on('syncEndMiniGame', (data) => {
        roomState.gameState = "PLAYING";
        if (data.isDefWin) {
            addServerLog(`[디펜스 성공] 수비가 성공하여 수비수(${data.defTeam} ${data.defId}번)가 공을 스틸했습니다!`, "defense");
        } else {
            addServerLog(`[디펜스 실패] 공격수(${data.attTeam} ${data.attId}번)가 수비를 제치고 돌파하여 공을 지켜냈습니다!`, "defense");
        }
        io.emit('onEndMiniGame', data);
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
            addServerLog(`[퇴장] ${teamMark} ${leftPlayer.ownerName} 유저의 연결이 끊어져 선수가 대기 상태로 전환되었습니다.`, "system");
            
            roomState.registeredOwners = roomState.registeredOwners.filter(p => p.socketId !== socket.id);
            io.emit('onRegisterOwner', { team: leftPlayer.team, id: leftPlayer.id, ownerName: "", skillLevel: 5.0 });
        }
    });
});

http.listen(PORT, () => {
    console.log(`서버 실행 중: http://localhost:${PORT}`);
});
