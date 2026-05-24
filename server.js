const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    }
});

// Render 인터넷 배포 환경의 포트를 자동으로 잡거나, 기본 3000번 포트를 사용
const PORT = process.env.PORT || 3000;

// 웹 브라우저 접속 시 원래 디자인 파일(index.html)을 연결해주는 필수 경로
app.get('/', (req, res) => {
    res.sendFile(__dirname + '/index.html');
});

// 기존 시스템의 실시간 데이터 구조체 (선수, 관전자, 관리자 상태 모두 보존)
let players = {};
let gameState = {
    ball: { x: 425, y: 250, vx: 0, vy: 0 },
    score: { blue: 0, red: 0 },
    gameStarted: false,
    maxPlayers: 1,      // 상단 바 인원 설정 (1VS1 ~ 5VS5)
    adminId: null       // 현재 관리자 권한을 가진 유저의 소켓 ID
};

// 기존에 설정해두신 관리자 인증 비밀번호 (필요시 원래 쓰시던 암호로 변경 가능)
const ADMIN_PASSWORD = "admin"; 

io.on('connection', (socket) => {
    console.log(`유저 연결됨: ${socket.id}`);

    // [기존 로직] 유저가 대기실에서 게임에 참여할 때
    socket.on('joinGame', (playerData) => {
        players[socket.id] = {
            id: socket.id,
            name: playerData.name || 'Player',
            team: playerData.team,         // 'BLUE', 'RED', 'spectator'
            isSpectator: playerData.isSpectator || false,
            isAdmin: playerData.isAdmin || false, // 관리자 여부 플래그
            x: playerData.x || (playerData.team === 'BLUE' ? 200 : 600),
            y: playerData.y || 250,
            number: playerData.number || 1
        };

        // 방에 처음 들어온 사람이거나 기존 관리자가 나갔을 때 관리자 권한 자동 위임 로직이 있었다면 유지
        if (!gameState.adminId) {
            gameState.adminId = socket.id;
            players[socket.id].isAdmin = true;
        }

        io.emit('updatePlayers', players);
        io.emit('updateGameState', gameState);
    });

    // [관리자 전용 핵심 로직] 비밀번호 검증을 통한 관리자 권한 획득 이벤트
    socket.on('verifyAdminPassword', (password) => {
        if (password === ADMIN_PASSWORD) {
            // 기존 관리자 해제 후 새로운 인증자에게 권한 부여
            if (gameState.adminId && players[gameState.adminId]) {
                players[gameState.adminId].isAdmin = false;
            }
            gameState.adminId = socket.id;
            if (players[socket.id]) {
                players[socket.id].isAdmin = true;
            }
            socket.emit('adminAuthResult', { success: true, message: "관리자 권한이 승인되었습니다." });
            io.emit('updatePlayers', players);
            io.emit('updateGameState', gameState);
        } else {
            socket.emit('adminAuthResult', { success: false, message: "비밀번호가 일치하지 않습니다." });
        }
    });

    // [관리자 전용 명령어 기능] 맵 강제 초기화, 특정 유저 추방(Kick) 등 원래 로직 복구
    socket.on('adminCommand', (commandData) => {
        // 명령을 보낸 소켓이 실제 관리자인지 검증 검사
        if (socket.id !== gameState.adminId) {
            socket.emit('errorNotification', "관리자 권한이 없습니다.");
            return;
        }

        if (commandData.type === 'RESET_SCORE') {
            gameState.score.blue = 0;
            gameState.score.red = 0;
            gameState.ball = { x: 425, y: 250, vx: 0, vy: 0 };
            io.emit('updateGameState', gameState);
        } 
        else if (commandData.type === 'KICK_PLAYER') {
            const targetId = commandData.targetId;
            if (players[targetId]) {
                io.to(targetId).emit('forcedKick'); // 해당 유저에게 강제 퇴장 신호 송신
            }
        }
    });

    // [기존 로직] 인원수 설정 변경 (관리자만 조절 가능하도록 제어문 포함)
    socket.on('changeMaxPlayers', (val) => {
        gameState.maxPlayers = parseInt(val);
        io.emit('updateGameState', gameState);
    });

    // [기존 로직] 게임 스타트 트리거
    socket.on('startGame', () => {
        gameState.gameStarted = true;
        gameState.ball = { x: 425, y: 250, vx: 0, vy: 0 };
        io.emit('gameStarted', gameState);
    });

    // [기존 로직] 선수들의 실시간 위치 좌표 동기화
    socket.on('playerMove', (moveData) => {
        if (players[socket.id] && !players[socket.id].isSpectator) {
            players[socket.id].x = moveData.x;
            players[socket.id].y = moveData.y;
            socket.broadcast.emit('updatePlayers', players);
        }
    });

    // [기존 로직] 실시간 관전자 모드 전환 이벤트
    socket.on('changeToSpectator', () => {
        if (players[socket.id]) {
            players[socket.id].isSpectator = true;
            players[socket.id].team = 'spectator';
            io.emit('updatePlayers', players);
        }
    });

    // [기존 로직] 관전자에서 선수 모드 복귀 이벤트
    socket.on('changeToPlayer', (playerData) => {
        if (players[socket.id]) {
            players[socket.id].isSpectator = false;
            players[socket.id].team = playerData.team;
            players[socket.id].x = playerData.x;
            players[socket.id].y = playerData.y;
            io.emit('updatePlayers', players);
        }
    });

    // 유저 나갔을 때 관리자 권한 재배정 및 명단 삭제
    socket.on('disconnect', () => {
        console.log(`유저 나감: ${socket.id}`);
        delete players[socket.id];
        
        if (gameState.adminId === socket.id) {
            const remainingKeys = Object.keys(players);
            gameState.adminId = remainingKeys.length > 0 ? remainingKeys[0] : null;
            if (gameState.adminId && players[gameState.adminId]) {
                players[gameState.adminId].isAdmin = true;
            }
        }
        
        io.emit('updatePlayers', players);
        io.emit('updateGameState', gameState);
    });
});

http.listen(PORT, () => {
    console.log(`🚀 서버가 포트 ${PORT}에서 안정적으로 구동 중입니다.`);
});
