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

let roomState = {
    gameState: "SETUP",
    currentMaxPairs: 5,
    teamBlueName: "TEAM BLUE",
    teamRedName: "TEAM RED",
    scoreBlue: 0,
    scoreRed: 0,
    registeredOwners: [] 
};

let prePauseState = "SETUP";

io.on('connection', (socket) => {
    console.log(`클라이언트 소켓 연결 완료: ${socket.id}`);

    // 접속한 유저에게 현재 방 상태 전송
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

    // 캐릭터 등록 시, 신청한 소켓의 ID(socket.id)를 함께 저장하여 소유권 격리
    socket.on('syncRegisterOwner', (data) => {
        const exists = roomState.registeredOwners.find(p => p.team === data.team && p.id === data.id);
        if (!exists) {
            data.skillLevel = 5.0;
            data.socketId = socket.id; // 소켓 식별자 주입
            roomState.registeredOwners.push(data);
        }
        io.emit('onRegisterOwner', data); // 전원에게 전송해서 내 캐릭터 브라우저에 매핑되도록 함
    });

    socket.on('syncUpdateSkillLevel', (data) => {
        const target = roomState.registeredOwners.find(p => p.team === data.team && p.id === data.id);
        if (target) {
            target.skillLevel = parseFloat(data.skillLevel);
        }
        io.emit('onUpdateSkillLevel', data);
    });

    socket.on('syncMatchType', (maxPairs) => {
        roomState.currentMaxPairs = maxPairs;
        socket.broadcast.emit('onMatchType', maxPairs);
    });

    socket.on('syncLiveTeamName', (data) => {
        if (data.team === "BLUE") {
            roomState.teamBlueName = data.name;
        } else if (data.team === "RED") {
            roomState.teamRedName = data.name;
        }
        socket.broadcast.emit('onLiveTeamName', data);
    });

    socket.on('syncStartGame', (data) => {
        roomState.gameState = "PLAYING";
        roomState.teamBlueName = data.teamBlueName;
        roomState.teamRedName = data.teamRedName;
        io.emit('onStartGame', data);
    });

    // 관리자 전용 전체 매치 완전 초기화
    socket.on('syncResetMatch', () => {
        roomState.gameState = "SETUP";
        roomState.scoreBlue = 0;
        roomState.scoreRed = 0;
        roomState.registeredOwners = [];
        prePauseState = "SETUP";
        io.emit('onResetMatch');
    });

    socket.on('syncTogglePause', () => {
        if (roomState.gameState === "PAUSE") {
            roomState.gameState = prePauseState;
            io.emit('onTogglePause', { gameState: roomState.gameState, isPaused: false });
        } else {
            prePauseState = roomState.gameState;
            roomState.gameState = "PAUSE";
            io.emit('onTogglePause', { gameState: "PAUSE", isPaused: true });
        }
    });

    socket.on('syncScore', (data) => {
        roomState.scoreBlue = data.blue;
        roomState.scoreRed = data.red;
        socket.broadcast.emit('onScore', data);
    });

    socket.on('syncStartDefense', (data) => {
        roomState.gameState = "MINIGAME";
        io.emit('onStartDefense', data);
    });

    socket.on('syncMiniGameTick', (data) => {
        socket.broadcast.emit('onMiniGameTick', data);
    });

    socket.on('syncMiniGameHit', (gauge) => {
        io.emit('onMiniGameHit', gauge);
    });

    socket.on('syncEndMiniGame', (isDefWin) => {
        roomState.gameState = "PLAYING";
        io.emit('onEndMiniGame', isDefWin);
    });

    // 접속 해제 시 해당 유저가 잡고 있던 캐릭터 반환 조치
    socket.on('disconnect', () => {
        console.log(`유저 연결 해제: ${socket.id}`);
        roomState.registeredOwners = roomState.registeredOwners.filter(p => p.socketId !== socket.id);
        io.emit('onRoomOwnersUpdate', roomState.registeredOwners);
    });
});

http.listen(PORT, () => {
    console.log(`서버 정상 기동 중. 포트번호: ${PORT}`);
});
