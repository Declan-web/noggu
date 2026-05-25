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
            roomState.registeredOwners.push(data);
        }
        socket.broadcast.emit('onRegisterOwner', data);
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

    socket.on('syncStartGame', (data) => {
        roomState.gameState = "PLAYING";
        roomState.teamBlueName = data.teamBlueName;
        roomState.teamRedName = data.teamRedName;
        io.emit('onStartGame', data);
    });

    socket.on('syncResetMatch', () => {
        roomState.gameState = "SETUP";
        roomState.scoreBlue = 0;
        roomState.scoreRed = 0;
        roomState.registeredOwners = [];
        io.emit('onResetMatch');
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
        socket.broadcast.emit('onMiniGameHit', gauge);
    });

    socket.on('syncEndMiniGame', (isDefWin) => {
        roomState.gameState = "PLAYING";
        io.emit('onEndMiniGame', isDefWin);
    });

    socket.on('disconnect', () => {
        console.log(`유저 연결 해제: ${socket.id}`);
    });
});

http.listen(PORT, () => {
    console.log(`서버 정상 기동 중. 포트번호: ${PORT}`);
});
