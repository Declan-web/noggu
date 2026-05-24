const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    }
});

// Render 배포 환경 포트 자동 매칭 (없으면 로컬 3000번 사용)
const PORT = process.env.PORT || 3000;

// 웹 브라우저 접속 시 원래 디자인 파일(index.html)을 정확히 띄워주는 경로 설정
app.get('/', (req, res) => {
    res.sendFile(__dirname + '/index.html');
});

// 기존 게임 상태 관리 데이터 (선수 명단, 공 위치, 점수 등 원래 로직 보존)
let players = {};
let gameState = {
    ball: { x: 400, y: 300, vx: 0, vy: 0 },
    score: { blue: 0, red: 0 },
    gameStarted: false,
    maxPlayers: 1 // 기본 1 VS 1 설정 값
};

io.on('connection', (socket) => {
    console.log(`유저 접속: ${socket.id}`);

    // 기존 유저가 방에 들어올 때 처리하던 이벤트
    socket.on('joinGame', (playerData) => {
        players[socket.id] = {
            id: socket.id,
            name: playerData.name || 'Player',
            team: playerData.team, // 'BLUE' 또는 'RED' 또는 'spectator'
            isSpectator: playerData.isSpectator || false,
            x: playerData.x || (playerData.team === 'BLUE' ? 200 : 600),
            y: playerData.y || 300,
            number: playerData.number || 1
        };
        // 전체에 현재 플레이어 상태 전송
        io.emit('updatePlayers', players);
        io.emit('updateGameState', gameState);
    });

    // 기존 인원 설정 변경 이벤트 (1 VS 1 ~ 5 VS 5)
    socket.on('changeMaxPlayers', (val) => {
        gameState.maxPlayers = parseInt(val);
        io.emit('updateGameState', gameState);
    });

    // 기존 게임 스타트 버튼 트리거
    socket.on('startGame', () => {
        gameState.gameStarted = true;
        // 공 위치 초기화 및 이동 상태 설정
        gameState.ball = { x: 400, y: 300, vx: 0, vy: 0 };
        io.emit('gameStarted', gameState);
    });

    // 플레이어 이동 동기화
    socket.on('playerMove', (moveData) => {
        if (players[socket.id] && !players[socket.id].isSpectator) {
            players[socket.id].x = moveData.x;
            players[socket.id].y = moveData.y;
            socket.broadcast.emit('updatePlayers', players);
        }
    });

    // 기존 관전자 전환 시스템 이벤트
    socket.on('changeToSpectator', () => {
        if (players[socket.id]) {
            players[socket.id].isSpectator = true;
            players[socket.id].team = 'spectator';
            io.emit('updatePlayers', players);
        }
    });

    // 퇴장 처리
    socket.on('disconnect', () => {
        console.log(`유저 퇴장: ${socket.id}`);
        delete players[socket.id];
        io.emit('updatePlayers', players);
    });
});

// 서버 기동 실행
http.listen(PORT, () => {
    console.log(`서버가 정상적으로 가동 중입니다. 포트: ${PORT}`);
});
