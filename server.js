// server.js
const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http, {
    cors: { origin: "*" } // 다른 주소에서의 접근을 허용 (CORS 차단 방지)
});

// HTML 파일들이 위치한 폴더를 지정 (기존 index.html이 있는 위치)
app.use(express.static(__dirname));

// 실시간으로 접속한 유저들의 좌표와 정보를 저장할 객체
let onlineUsers = {};

io.on('connection', (socket) => {
    console.log(`📡 새 유저 접속함! (ID: ${socket.id})`);

    // 1. 유저가 대기실에서 캐릭터를 선점했을 때 호출됨
    socket.on('join_player', (data) => {
        onlineUsers[socket.id] = {
            playerId: data.id,       // 캐릭터 번호 (1~5)
            team: data.team,         // BLUE or RED
            ownerName: data.ownerName, // 유저 이름
            x: data.x,
            y: data.y,
            angle: data.angle
        };
        // 현재 접속해 있는 모든 유저들에게 갱신된 명단 전송
        io.emit('sync_lobby', onlineUsers);
    });

    // 2. 누군가 방향키로 캐릭터를 움직일 때 실시간으로 중계
    socket.on('move_player', (data) => {
        if (onlineUsers[socket.id]) {
            onlineUsers[socket.id].x = data.x;
            onlineUsers[socket.id].y = data.y;
            onlineUsers[socket.id].angle = data.angle;
            
            // 신호를 보낸 사람을 제외한 '다른 모든 유저'들에게 이 좌표를 뿌림
            socket.broadcast.emit('update_remote_player', {
                socketId: socket.id,
                x: data.x,
                y: data.y,
                angle: data.angle
            });
        }
    });

    // 3. 공의 물리 상태(위치, 속도, 소유자) 실시간 중계
    socket.on('sync_ball', (ballData) => {
        socket.broadcast.emit('update_ball_state', ballData);
    });

    // 4. 디펜스 미니게임 트리거 중계
    socket.on('trigger_defense', (data) => {
        socket.broadcast.emit('start_defense_match', data);
    });

    // 5. 접속 종료 처리
    socket.on('disconnect', () => {
        console.log(`❌ 유저 나감 (ID: ${socket.id})`);
        delete onlineUsers[socket.id];
        io.emit('sync_lobby', onlineUsers);
    });
});

// 서버 포트 설정 (Render 배포를 위해 process.env.PORT 지원)
const PORT = process.env.PORT || 3000;
http.listen(PORT, () => {
    console.log(`🚀 멀티플레이 서버가 http://localhost:${PORT} 에서 작동 중입니다!`);
});