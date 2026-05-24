const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    }
});

// Render 배포 환경의 동적 포트를 자동으로 잡거나, 로컬용 3000번 포트를 사용하도록 설정
const PORT = process.env.PORT || 3000;

// Render 접속 시 첫 화면으로 index.html을 연결해주는 필수 경로 (Not Found 해결)
app.get('/', (req, res) => {
    res.sendFile(__dirname + '/index.html');
});

// 기존 실시간 접속 플레이어 및 관전자 관리 데이터 객체
let players = {};

io.on('connection', (socket) => {
    console.log(`유저 접속됨: ${socket.id}`);

    // 기존 로그인 및 게임 참여 (관전자 모드 대응 데이터 구조 유지)
    socket.on('joinGame', (playerData) => {
        players[socket.id] = {
            id: socket.id,
            name: playerData.name,
            team: playerData.team,         // 'A', 'B', 또는 'spectator'(관전자)
            isSpectator: playerData.isSpectator || false,
            x: playerData.x || 400,
            y: playerData.y || 300
        };
        // 현재 접속 중인 모든 유저에게 상태 갱신 공유
        io.emit('updatePlayers', players);
    });

    // 플레이어가 움직였을 때 실시간 위치 동기화
    socket.on('playerMove', (moveData) => {
        if (players[socket.id] && !players[socket.id].isSpectator) {
            players[socket.id].x = moveData.x;
            players[socket.id].y = moveData.y;
            // 다른 사람들에게 실시간 위치 전달
            socket.broadcast.emit('updatePlayers', players);
        }
    });

    // 기존 관전자 모드 전환 이벤트 대응
    socket.on('changeToSpectator', () => {
        if (players[socket.id]) {
            players[socket.id].isSpectator = true;
            players[socket.id].team = 'spectator';
            io.emit('updatePlayers', players);
        }
    });

    // 기존 선수 모드 복귀 이벤트 대응
    socket.on('changeToPlayer', (playerData) => {
        if (players[socket.id]) {
            players[socket.id].isSpectator = false;
            players[socket.id].team = playerData.team;
            players[socket.id].x = playerData.x;
            players[socket.id].y = playerData.y;
            io.emit('updatePlayers', players);
        }
    });

    // 유저 접속 종료 시 명단에서 제외
    socket.on('disconnect', () => {
        console.log(`유저 나감: ${socket.id}`);
        delete players[socket.id];
        io.emit('updatePlayers', players);
    });
});

// 서버 기동 실행 로그
http.listen(PORT, () => {
    console.log(`🚀 서버가 작동 중입니다! 포트번호: ${PORT}`);
});
