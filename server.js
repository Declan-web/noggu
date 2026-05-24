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

// Render 접속 시 index.html 파일 매칭
app.get('/', (req, res) => {
    res.sendFile(__dirname + '/index.html');
});

let players = {};
let gameState = {
    ball: { x: 425, y: 250, vx: 0, vy: 0 },
    score: { blue: 0, red: 0 },
    gameStarted: false,
    maxPlayers: 1
};

io.on('connection', (socket) => {
    console.log(`유저 접속: ${socket.id}`);

    socket.on('joinGame', (playerData) => {
        // 새로 접속한 유저를 반대 진영에 배치하기 위한 기초 카운트 분기 로직
        const playerCount = Object.keys(players).length;
        const assignedTeam = (playerCount % 2 === 0) ? 'BLUE' : 'RED';

        players[socket.id] = {
            id: socket.id,
            name: playerData.name || 'Player',
            team: assignedTeam,
            x: assignedTeam === 'BLUE' ? 200 : 650,
            y: 250,
            number: (assignedTeam === 'BLUE') ? Math.floor(playerCount/2) + 1 : Math.floor(playerCount/2) + 1
        };
        io.emit('updatePlayers', players);
        io.emit('updateGameState', gameState);
    });

    socket.on('changeMaxPlayers', (val) => {
        gameState.maxPlayers = parseInt(val);
        io.emit('updateGameState', gameState);
    });

    socket.on('startGame', () => {
        gameState.gameStarted = true;
        gameState.ball = { x: 425, y: 250, vx: 0, vy: 0 };
        io.emit('gameStarted', gameState);
    });

    socket.on('playerMove', (moveData) => {
        if (players[socket.id]) {
            players[socket.id].x = moveData.x;
            players[socket.id].y = moveData.y;
            socket.broadcast.emit('updatePlayers', players);
        }
    });

    socket.on('disconnect', () => {
        console.log(`유저 퇴장: ${socket.id}`);
        delete players[socket.id];
        io.emit('updatePlayers', players);
    });
});

http.listen(PORT, () => {
    console.log(`서버 작동 중. 포트: ${PORT}`);
});
