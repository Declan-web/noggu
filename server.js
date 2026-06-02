const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.get('/', (req, res) => {
    res.sendFile(__dirname + '/index.html');
});

// 서버 측 게임 상태 관리 변수
let gameState = "SETUP"; 
let players = [];
let ball = { x: 500, y: 250, holderId: null, isFlying: false };

let blueCount = 0;
let redCount = 0;

io.on('connection', (socket) => {
    console.log('유저가 접속했습니다:', socket.id);

    // 팀 및 플레이어 ID 자동 배정 로직
    let team = "BLUE";
    let id = blueCount + 1;
    
    if (blueCount > redCount) {
        team = "RED";
        id = redCount + 1;
        redCount++;
    } else {
        blueCount++;
    }

    const newPlayer = {
        id: id,
        team: team,
        x: team === "BLUE" ? 200 : 800,
        y: 250
    };
    
    players.push(newPlayer);

    // 클라이언트에게 최초 제어권 부여 및 상태 동기화
    socket.emit('initControlPlayer', newPlayer);
    io.emit('syncGameState', { state: gameState, players: players });
    socket.emit('onBallAction', ball);

    // [핵심] 캐릭터 실시간 이동 동기화 처리
    socket.on('syncPlayerMovement', (data) => {
        const player = players.find(p => p.id === data.id && p.team === data.team);
        if (player) {
            player.x = data.x;
            player.y = data.y;
        }
        // 위치가 업데이트된 전체 플레이어 정보를 다시 모든 클라이언트에 브로드캐스트
        io.emit('syncGameState', { state: gameState, players: players });
    });

    // [핵심] 공 상태 변경 동기화 처리 (줍기, 슛, 패스)
    socket.on('syncBallAction', (data) => {
        ball.x = data.x;
        ball.y = data.y;
        ball.isFlying = data.isFlying;
        ball.holderId = data.holderId; 

        io.emit('onBallAction', ball);
    });

    // 수비 동작 로그 전송
    socket.on('defenseTrigger', (data) => {
        io.emit('logNotification', `[경기] ${data.team}팀 ${data.id}번 선수가 강력한 수비를 시도합니다!`);
    });

    // 감독 권한 인증 처리
    socket.on('authReferee', (data) => {
        if (data.key === "1234") { 
            io.emit('logNotification', `[알림] ${data.name} 님이 감독 권한을 획득했습니다.`);
        } else {
            socket.emit('logNotification', `[시스템] 감독 인증 코드가 올바르지 않습니다.`);
        }
    });

    // 게임 시작 처리
    socket.on('requestStartGame', () => {
        gameState = "PLAYING";
        io.emit('syncGameState', { state: gameState, players: players });
        io.emit('logNotification', `[시스템] 경기가 시작되었습니다! 모두 포지션으로 이동하세요.`);
    });

    // 게임 일시정지 및 재개 처리
    socket.on('requestTogglePause', () => {
        if (gameState === "PLAYING") {
            gameState = "PAUSED";
            io.emit('logNotification', `[시스템] 감독 요청으로 경기가 일시 정지되었습니다.`);
        } else if (gameState === "PAUSED") {
            gameState = "PLAYING";
            io.emit('logNotification', `[시스템] 경기가 다시 재개됩니다.`);
        }
        io.emit('syncGameState', { state: gameState, players: players });
    });

    // 유저 접속 해제 처리
    socket.on('disconnect', () => {
        console.log('유저가 나갔습니다:', socket.id);
        players = players.filter(p => p.id !== id || p.team !== team);
        if (team === "BLUE") blueCount = Math.max(0, blueCount - 1);
        if (team === "RED") redCount = Math.max(0, redCount - 1);
        
        io.emit('syncGameState', { state: gameState, players: players });
        io.emit('logNotification', `[시스템] ${team}팀 ${id}번 선수가 경기장을 이탈했습니다.`);
    });
});

const PORT = 3000;
server.listen(PORT, () => {
    console.log(`서버가 성공적으로 시작되었습니다. http://localhost:${PORT}`);
});
