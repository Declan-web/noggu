const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http, {
    cors: { origin: "*", methods: ["GET", "POST"] }
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
    return logEntry;
}

io.on('connection', (socket) => {
    socket.emit('onInitRoomState', roomState);

    // [이동 동기화]
    socket.on('syncPlayerMovement', (data) => {
        socket.broadcast.emit('onPlayerMovement', data);
    });

    // [핵심 해결 1: 공 줍기/슛/패스 동기화]
    // 기존에 누락되었던 공 상호작용을 broadcast하여 모든 클라이언트가 공의 위치를 공유함
    socket.on('syncBallAction', (data) => {
        socket.broadcast.emit('onBallAction', data);
    });

    // [선수 등록]
    socket.on('syncRegisterOwner', (data) => {
        roomState.registeredOwners = roomState.registeredOwners.filter(p => !(p.team === data.team && p.id === data.id));
        roomState.registeredOwners.push({ ...data, socketId: socket.id });
        io.emit('onRegisterOwner', data);
    });

    // [게임 상태 및 감독 권한]
    socket.on('syncGameState', (data) => {
        roomState.gameState = data.state;
        io.emit('onGameStateChange', data);
    });

    socket.on('syncRefereeAuth', (data) => {
        roomState.directorName = data.name;
        roomState.directorSocketId = socket.id;
        io.emit('onRegisterDirector', { directorName: data.name, directorSocketId: socket.id });
    });

    // [점수 및 미니게임]
    socket.on('syncScore', (data) => {
        roomState.scoreBlue = data.blue;
        roomState.scoreRed = data.red;
        io.emit('onScoreUpdate', data);
    });

    socket.on('syncEndMiniGame', (data) => {
        roomState.gameState = "PLAYING";
        io.emit('onEndMiniGame', data);
    });

    // [핵심 해결 2: 연결 종료 시 선수 슬롯 초기화]
    // 나간 유저의 정보를 찾아 배열에서 제거하고, 빈 슬롯 상태를 모든 클라이언트에 알림
    socket.on('disconnect', () => {
        const leftPlayer = roomState.registeredOwners.find(p => p.socketId === socket.id);
        if (leftPlayer) {
            roomState.registeredOwners = roomState.registeredOwners.filter(p => p.socketId !== socket.id);
            // 슬롯 비우기 신호 (빈 이름으로 업데이트)
            io.emit('onRegisterOwner', { team: leftPlayer.team, id: leftPlayer.id, ownerName: "", skillLevel: 5.0 });
            addServerLog(`[시스템] ${leftPlayer.name} 님이 퇴장하여 슬롯이 초기화되었습니다.`);
        }

        if (socket.id === roomState.directorSocketId) {
            roomState.directorName = null;
            roomState.directorSocketId = null;
            io.emit('onRegisterDirector', { directorName: null, directorSocketId: null });
        }
    });

    socket.on('sendDirectorChat', (msg) => {
        const name = roomState.directorName || "미지정";
        addServerLog(`[감독 ${name}] ${msg}`, "chat");
    });
});

http.listen(PORT, () => {
    console.log(`서버 실행 중: http://localhost:${PORT}`);
});
