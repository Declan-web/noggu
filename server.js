const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    }
});

// 1. Render 배포 환경의 동적 포트를 자동으로 잡거나, 로컬용 3000번 포트를 사용하도록 설정
const PORT = process.env.PORT || 3000;

// 2. [가장 중요] Render에 접속했을 때 내 index.html 파일을 메인 화면으로 띄워주는 핵심 연결 코드 (Not Found 에러 해결)
app.get('/', (req, res) => {
    res.sendFile(__dirname + '/index.html');
});

// 실시간 플레이어 명단 데이터 객체
let players = {};

io.on('connection', (socket) => {
    console.log(`유저 접속됨: ${socket.id}`);

    // 사용자가 대기실에서 '게임 참여하기'를 눌렀을 때
    socket.on('joinGame', (playerData) => {
        players[socket.id] = {
            id: socket.id,
            name: playerData.name,
            team: playerData.team,
            x: playerData.x,
            y: playerData.y
        };
        // 현재 접속 중인 전원에게 플레이어 명단 최신화
        io.emit('updatePlayers', players);
    });

    // 플레이어가 방향키나 WASD로 움직일 때 실시간 좌표 동기화
    socket.on('playerMove', (moveData) => {
        if (players[socket.id]) {
            players[socket.id].x = moveData.x;
            players[socket.id].y = moveData.y;
            // 나를 제외한 다른 사람들에게 실시간 위치 브로드캐스팅
            socket.broadcast.emit('updatePlayers', players);
        }
    });

    // 유저가 브라우저를 닫거나 접속을 끊었을 때 명단에서 제거
    socket.on('disconnect', () => {
        console.log(`유저 나감: ${socket.id}`);
        delete players[socket.id];
        io.emit('updatePlayers', players);
    });
});

// 3. 서버 실행 포트를 변수 PORT 값으로 지정
http.listen(PORT, () => {
    console.log(`🚀 서버가 작동 중입니다! 포트번호: ${PORT}`);
});
