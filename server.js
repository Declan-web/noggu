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

// [핵심] 서버에서 실시간 방 상태를 저장하는 마스터 객체 생성
let roomState = {
    gameState: "SETUP",
    currentMaxPairs: 5,
    teamBlueName: "TEAM BLUE",
    teamRedName: "TEAM RED",
    scoreBlue: 0,
    scoreRed: 0,
    registeredOwners: [] // [{team: 'BLUE', id: 1, ownerName: 'Chaehee'}, ...] 형태로 저장
};

io.on('connection', (socket) => {
    console.log(`클라이언트 소켓 연결 완료: ${socket.id}`);

    // 1. 유저가 새로고침하거나 첫 진입 시, 서버에 저장된 최신 방 상태를 즉시 전송
    socket.emit('onInitRoomState', roomState);

    // 위치 데이터 중계
    socket.on('syncPlayerMove', (data) => {
        socket.broadcast.emit('onPlayerMove', data);
    });

    // 볼 실시간 주사 위치 동기화
    socket.on('syncBallLocation', (data) => {
        socket.broadcast.emit('onBallLocation', data);
    });

    // 슛/패스/선점 등의 액션 전파
    socket.on('syncBallAction', (data) => {
        io.emit('onBallAction', data);
    });

    // 유저 선점 상태를 서버 배열에 기록 후 브로드캐스트
    socket.on('syncRegisterOwner', (data) => {
        // 중복 등록 방지 체크 후 삽입
        const exists = roomState.registeredOwners.find(p => p.team === data.team && p.id === data.id);
        if (!exists) {
            roomState.registeredOwners.push(data);
        }
        socket.broadcast.emit('onRegisterOwner', data);
    });

    // 인원수 변경 동기화 및 서버 저장
    socket.on('syncMatchType', (maxPairs) => {
        roomState.currentMaxPairs = maxPairs;
        socket.broadcast.emit('onMatchType', maxPairs);
    });

    // 게임 시작 동기화 및 서버 저장
    socket.on('syncStartGame', (data) => {
        roomState.gameState = "PLAYING";
        roomState.teamBlueName = data.teamBlueName;
        roomState.teamRedName = data.teamRedName;
        io.emit('onStartGame', data);
    });

    // 리셋 동기화 및 서버 저장 데이터 초기화
    socket.on('syncResetMatch', () => {
        roomState.gameState = "SETUP";
        roomState.scoreBlue = 0;
        roomState.scoreRed = 0;
        roomState.registeredOwners = []; // 선점 명단 리셋
        io.emit('onResetMatch');
    });

    // 스코어 갱신 및 서버 저장
    socket.on('syncScore', (data) => {
        roomState.scoreBlue = data.blue;
        roomState.scoreRed = data.red;
        socket.broadcast.emit('onScore', data);
    });

    // 디펜스 미니게임 진입 선포
    socket.on('syncStartDefense', (data) => {
        roomState.gameState = "MINIGAME";
        io.emit('onStartDefense', data);
    });

    // 미니게임 게이지 실시간 동기화
    socket.on('syncMiniGameTick', (data) => {
        socket.broadcast.emit('onMiniGameTick', data);
    });

    // 유저 스페이스바 입력값 타격 반영 중계
    socket.on('syncMiniGameHit', (gauge) => {
        socket.broadcast.emit('onMiniGameHit', gauge);
    });

    // 미니게임 종료 선언 판정 및 상태 복구
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
