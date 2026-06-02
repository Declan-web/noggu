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

// 방 상태 관리
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

    // [공 줍기 및 액션 처리 - 추가됨]
    socket.on('syncBallAction', (data) => {
        // 공 상태를 서버가 관리하고 모든 클라이언트에게 공유
        socket.broadcast.emit('onBallAction', data);
    });

    // [선수 선택 등록 및 초기화 관련]
    socket.on('syncRegisterOwner', (data) => {
        // 기존 동일 위치 등록자 제거 (초기화 방지)
        roomState.registeredOwners = roomState.registeredOwners.filter(p => !(p.team === data.team && p.id === data.id));
        roomState.registeredOwners.push({ ...data, socketId: socket.id });
        io.emit('onRegisterOwner', data);
    });

    // [감독 권한 인증]
    socket.on('syncRefereeAuth', (data) => {
        roomState.directorName = data.name;
        roomState.directorSocketId = socket.id;
        io.emit('onRegisterDirector', { directorName: data.name, directorSocketId: socket.id });
    });

    // [게임 제어]
    socket.on('syncGameState', (data) => {
        roomState.gameState = data.state;
        io.emit('onGameStateChange', data);
    });

    // [연결 종료 시 선수 슬롯 초기화 - 해결됨]
    socket.on('disconnect', () => {
        // 나간 유저가 등록한 선수 슬롯을 찾아 삭제
        const leftPlayer = roomState.registeredOwners.find(p => p.socketId === socket.id);
        if (leftPlayer) {
            roomState.registeredOwners = roomState.registeredOwners.filter(p => p.socketId !== socket.id);
            // 전체 클라이언트에게 해당 슬롯이 비었음을 알림
            io.emit('onInitRoomState', roomState); 
            addServerLog(`[시스템] ${leftPlayer.name} 님이 퇴장하여 슬롯이 초기화되었습니다.`);
        }
        
        if (socket.id === roomState.directorSocketId) {
            roomState.directorName = null;
            roomState.directorSocketId = null;
            io.emit('onRegisterDirector', { directorName: null, directorSocketId: null });
        }
    });

    // 기타 기존 로직들 (점수, 로그 등) 생략 없이 포함 가능
    socket.on('syncScore', (data) => {
        roomState.scoreBlue = data.blue;
        roomState.scoreRed = data.red;
        io.emit('onScoreUpdate', data);
    });
});

http.listen(PORT, () => {
    console.log(`서버 실행 중: http://localhost:${PORT}`);
});
