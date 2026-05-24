const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    }
});

// Render 배포 환경의 포트를 자동으로 잡거나, 없으면 기본 3000번 포트를 사용하도록 설정
const PORT = process.env.PORT || 3000;

// 사용자가 사이트에 접속했을 때 첫 화면으로 index.html 파일을 보내주는 경로 설정 (Not Found 해결)
app.get('/', (req, res) => {
    res.sendFile(__dirname + '/index.html');
});

// 실시간 접속 유저 데이터 관리 객체
let players = {};

io.on('connection', (socket) => {
    console.log(`유저 접속됨: ${socket.id}`);

    // 새로운 플레이어가 닉네임을 입력하고 게임에 참여했을 때
    socket.on('joinGame', (playerData) => {
        players[socket.id] = {
            id: socket.id,
            name: playerData.name,
            team: playerData.team,
            x: playerData.x || 400,
            y: playerData.y || 300
        };
        // 현재 접속 중인 모든 플레이어들에게 갱신된 명단 전송
        io.emit('updatePlayers', players);
    });

    // 플레이어가 방향키나 WASD로 움직였을 때 실시간 좌표 동기화
    socket.on('playerMove', (moveData) => {
        if (players[socket.id]) {
            players[socket.id].x = moveData.x;
            players[socket.id].y = moveData.y;
            // 다른 모든 접속자들에게 변경된 위치 정보 전달
            socket.broadcast.emit('updatePlayers', players);
        }
    });

    // 유저가 브라우저 창을 닫거나 나갔을 때 명단에서 제거
    socket.on('disconnect', () => {
        console.log(`유저 나감: ${socket.id}`);
        delete players[socket.id];
        io.emit('updatePlayers', players);
    });
});

// 서버 가동 및 시작 로그 출력
http.listen(PORT, () => {
    console.log(`🚀 멀티플레이 서버가 작동 중입니다!`);
});
