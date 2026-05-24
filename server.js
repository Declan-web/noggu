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

// Render 서버 라우팅 대응 (Not Found 처리 완료)
app.get('/', (req, res) => {
    res.sendFile(__dirname + '/index.html');
});

io.on('connection', (socket) => {
    console.log(`클라이언트 소켓 연결 완료: ${socket.id}`);

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

    // 유저 선점 네임드 배포
    socket.on('syncRegisterOwner', (data) => {
        socket.broadcast.emit('onRegisterOwner', data);
    });

    // 인원수 변경 동기화
    socket.on('syncMatchType', (maxPairs) => {
        socket.broadcast.emit('onMatchType', maxPairs);
    });

    // 게임 시작 동기화
    socket.on('syncStartGame', (data) => {
        io.emit('onStartGame', data);
    });

    // 리셋 동기화
    socket.on('syncResetMatch', () => {
        io.emit('onResetMatch');
    });

    // 스코어 갱신
    socket.on('syncScore', (data) => {
        socket.broadcast.emit('onScore', data);
    });

    // 디펜스 미니게임 진입 선포
    socket.on('syncStartDefense', (data) => {
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

    // 미니게임 종료 선언 판정
    socket.on('syncEndMiniGame', (isDefWin) => {
        io.emit('onEndMiniGame', isDefWin);
    });

    socket.on('disconnect', () => {
        console.log(`유저 연결 해제: ${socket.id}`);
    });
});

http.listen(PORT, () => {
    console.log(`서버 정상 기동 중. 포트번호: ${PORT}`);
});
