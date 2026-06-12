const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http);
const path = require('path');

app.use(express.static(path.join(__dirname, '')));

// 🏢 여러 방의 상태를 개별적으로 관리할 객체
const rooms = {};

// 특정 방의 초기 상태를 생성하는 함수
function createNewRoom(roomId) {
    return {
        roomId: roomId,
        scoreBlue: 0,
        scoreRed: 0,
        teamBlueName: "TEAM BLUE",
        teamRedName: "TEAM RED",
        maxBluePlayers: 5,
        maxRedPlayers: 5,
        gameState: "SETUP", // SETUP, PLAYING, MINIGAME, PAUSE
        directorName: null,
        directorToken: null,
        globalDefenseLockUntil: 0,
        registeredOwners: [], // { team, id, ownerName, socketId, userToken, skillLevel }
        logs: [],
        miniGameGauge: 50,
        activeDefender: null,
        activeAttacker: null
    };
}

function getTimestamp() {
    const now = new Date();
    return now.toTimeString().split(' ')[0];
}

function addLogToRoom(room, type, message) {
    const logEntry = {
        timestamp: getTimestamp(),
        type: type, // score, defense, chat, system
        message: message
    };
    room.logs.push(logEntry);
    if (room.logs.length > 40) room.logs.shift();
    io.to(room.roomId).emit("onNewLog", logEntry);
}

io.on('connection', (socket) => {
    let currentRoomId = null;
    console.log(`[서버] 새로운 소켓 연결 성공: ${socket.id}`);

    // 1. 방 접속 요청 처리
    socket.on('joinRoom', (roomId) => {
        if (!roomId || roomId.trim() === "") {
            console.log(`[서버] 잘못된 방 코드 접근 차단`);
            return;
        }
        
        currentRoomId = roomId.trim();
        socket.join(currentRoomId);
        console.log(`[서버] 소켓 [${socket.id}]이 방 [${currentRoomId}]에 입장함`);

        // 방이 존재하지 않으면 새로 생성
        if (!rooms[currentRoomId]) {
            rooms[currentRoomId] = createNewRoom(currentRoomId);
            console.log(`[서버] 새로운 방 생성 완료: ${currentRoomId}`);
        }

        const room = rooms[currentRoomId];

        // 클라이언트에게 현재 방의 모든 상태 전송
        socket.emit('onInitRoomState', {
            scoreBlue: room.scoreBlue,
            scoreRed: room.scoreRed,
            maxBluePlayers: room.maxBluePlayers,
            maxRedPlayers: room.maxRedPlayers,
            teamBlueName: room.teamBlueName,
            teamRedName: room.teamRedName,
            gameState: room.gameState,
            directorName: room.directorName,
            directorToken: room.directorToken,
            globalDefenseLockUntil: room.globalDefenseLockUntil,
            registeredOwners: room.registeredOwners,
            logs: room.logs
        });

        addLogToRoom(room, 'system', `새로운 관전자가 접속했습니다.`);
    });

    // 2. 실시간 캐릭터 이동 동기화
    socket.on('syncPlayerMove', (data) => {
        if (!currentRoomId) return;
        socket.to(currentRoomId).emit('onPlayerMove', data);
    });

    // 3. 실시간 공 데이터 동기화
    socket.on('syncBallAction', (data) => {
        if (!currentRoomId) return;
        socket.to(currentRoomId).emit('onBallAction', data);
    });

    // 4. 감독 임명/등록
    socket.on('syncRegisterDirector', (data) => {
        if (!currentRoomId || !rooms[currentRoomId]) return;
        const room = rooms[currentRoomId];

        if (!room.directorToken || room.directorToken === data.token) {
            room.directorName = data.name;
            room.directorToken = data.token;
            io.to(currentRoomId).emit('onRegisterDirector', {
                directorName: room.directorName,
                directorToken: room.directorToken
            });
            addLogToRoom(room, 'system', `[${data.name}]님이 경기 감독관으로 부임했습니다.`);
        } else {
            socket.emit('onRegisterDirector', {
                directorName: room.directorName,
                directorToken: room.directorToken
            });
        }
    });

    // 5. 캐릭터 명단 등록 및 양도
    socket.on('syncRegisterOwner', (data) => {
        if (!currentRoomId || !rooms[currentRoomId]) return;
        const room = rooms[currentRoomId];

        room.registeredOwners = room.registeredOwners.filter(
            o => !(o.team === data.team && o.id === data.id)
        );

        if (data.ownerName !== "") {
            room.registeredOwners.push({
                team: data.team,
                id: data.id,
                ownerName: data.ownerName,
                socketId: socket.id,
                userToken: data.userToken,
                skillLevel: 5.0
            });
            addLogToRoom(room, 'system', `[${data.team}] ${data.id}번에 ${data.ownerName}님이 등록되었습니다.`);
        }
        io.to(currentRoomId).emit('onRegisterOwner', data);
    });

    // 6. 재접속 세션 복구 처리
    socket.on('reconnectPlayer', (data) => {
        if (!currentRoomId || !rooms[currentRoomId]) return;
        const room = rooms[currentRoomId];
        const p = room.registeredOwners.find(o => o.userToken === data.userToken);
        if (p) {
            p.socketId = socket.id;
        }
    });

    // 7. 팀 경기력 스킬 수정
    socket.on('syncUpdateSkillLevel', (data) => {
        if (!currentRoomId || !rooms[currentRoomId]) return;
        const room = rooms[currentRoomId];
        const p = room.registeredOwners.find(o => o.team === data.team && o.id === data.id);
        if (p) {
            p.skillLevel = data.skillLevel;
            io.to(currentRoomId).emit('onUpdateSkillLevel', data);
            addLogToRoom(room, 'system', `감독 권한으로 [${p.ownerName}]의 경기력이 ${data.skillLevel.toFixed(1)}v로 변경되었습니다.`);
        }
    });

    // 8. 매치 최대 인원 변경
    socket.on('syncMatchCapacity', (data) => {
        if (!currentRoomId || !rooms[currentRoomId]) return;
        const room = rooms[currentRoomId];
        room.maxBluePlayers = data.blueMax;
        room.maxRedPlayers = data.redMax;
        io.to(currentRoomId).emit('onMatchCapacityChange', data);
    });

    // 9. 실시간 팀 이름 변경
    socket.on('syncLiveTeamName', (data) => {
        if (!currentRoomId || !rooms[currentRoomId]) return;
        const room = rooms[currentRoomId];
        if (data.team === "BLUE") room.teamBlueName = data.name;
        else room.teamRedName = data.name;
        socket.to(currentRoomId).emit('onLiveTeamName', data);
    });

    // 10. 경기 공식 시작
    socket.on('syncStartGame', (data) => {
        if (!currentRoomId || !rooms[currentRoomId]) return;
        const room = rooms[currentRoomId];
        room.gameState = "PLAYING";
        room.teamBlueName = data.teamBlueName;
        room.teamRedName = data.teamRedName;
        room.maxBluePlayers = data.maxBluePlayers;
        room.maxRedPlayers = data.maxRedPlayers;
        room.globalDefenseLockUntil = 0;
        io.to(currentRoomId).emit('onStartGame', data);
        addLogToRoom(room, 'system', `🏀 경기가 공식적으로 개시되었습니다! 파이팅!`);
    });

    // 11. 일시정지 (PAUSE) 토글
    socket.on('syncTogglePause', () => {
        if (!currentRoomId || !rooms[currentRoomId]) return;
        const room = rooms[currentRoomId];
        if (room.gameState === "PLAYING") {
            room.gameState = "PAUSE";
        } else if (room.gameState === "PAUSE") {
            room.gameState = "PLAYING";
        }
        io.to(currentRoomId).emit('onGameStateChange', { state: room.gameState });
        addLogToRoom(room, 'system', `경기가 일시 정지되거나 해제되었습니다.`);
    });

    // 12. 전체 완전 초기화 (RESET)
    socket.on('syncResetMatch', () => {
        if (!currentRoomId || !rooms[currentRoomId]) return;
        rooms[currentRoomId] = createNewRoom(currentRoomId);
        io.to(currentRoomId).emit('onResetMatch');
    });

    // 13. 스코어 동기화
    socket.on('syncScore', (data) => {
        if (!currentRoomId || !rooms[currentRoomId]) return;
        const room = rooms[currentRoomId];
        room.scoreBlue = data.blue;
        room.scoreRed = data.red;
        socket.to(currentRoomId).emit('onScoreUpdate', data);

        const currentScoringTeamName = data.scoringTeam === "BLUE" ? room.teamBlueName : room.teamRedName;
        addLogToRoom(room, 'score', `🎉 ${currentScoringTeamName}팀 득점! [${room.scoreBlue} : ${room.scoreRed}]`);
    });

    // 14. 미니게임 발동 시작
    socket.on('syncStartMiniGame', (data) => {
        if (!currentRoomId || !rooms[currentRoomId]) return;
        const room = rooms[currentRoomId];
        room.gameState = "MINIGAME";
        room.miniGameGauge = 50;
        room.activeDefender = { team: data.defTeam, id: data.defId };
        room.activeAttacker = { team: data.attTeam, id: data.attId };

        io.to(currentRoomId).emit('onStartMiniGame', data);
    });

    // 15. 연타 게이지 실시간 변화 축적
    socket.on('syncMiniGameHit', (gauge) => {
        if (!currentRoomId || !rooms[currentRoomId]) return;
        const room = rooms[currentRoomId];
        room.miniGameGauge = gauge;
        socket.to(currentRoomId).emit('onMiniGameGauge', gauge);
    });

    // 16. 미니게임 타임아웃 종료 판정
    socket.on('syncEndMiniGame', (resultData) => {
        if (!currentRoomId || !rooms[currentRoomId]) return;
        const room = rooms[currentRoomId];
        room.gameState = "PLAYING";
        room.globalDefenseLockUntil = Date.now() + 5000; 

        resultData.globalDefenseLockUntil = room.globalDefenseLockUntil;
        io.to(currentRoomId).emit('onEndMiniGame', resultData);

        const defObj = room.registeredOwners.find(o => o.team === resultData.defTeam && o.id === resultData.defId);
        const attObj = room.registeredOwners.find(o => o.team === resultData.attTeam && o.id === resultData.attId);
        const defenderName = defObj ? defObj.ownerName : "수비수";
        const attackerName = attObj ? attObj.ownerName : "공격수";

        if (resultData.isDefWin) {
            addLogToRoom(room, 'defense', `🛡️ [${defenderName}] 수비 성공! [${attackerName}]의 공을 빼앗아 가로챕니다.`);
        } else {
            addLogToRoom(room, 'defense', `⚡ [${attackerName}] 돌파 성공! 수비수 무력화 및 공격 흐름 유지!`);
        }
    });

    // 17. 감독관 전체 공지 채팅 공지
    socket.on('sendDirectorChat', (text) => {
        if (!currentRoomId || !rooms[currentRoomId]) return;
        const room = rooms[currentRoomId];
        const name = room.directorName || "감독";
        addLogToRoom(room, 'chat', `📢 [${name}]: ${text}`);
    });

    // 18. 로그 삭제 초기화
    socket.on('syncClearLogs', () => {
        if (!currentRoomId || !rooms[currentRoomId]) return;
        const room = rooms[currentRoomId];
        room.logs = [];
        io.to(currentRoomId).emit('onClearLogs');
    });

    // 19. 접속 종료 처리
    socket.on('disconnect', () => {
        if (currentRoomId && rooms[currentRoomId]) {
            const room = rooms[currentRoomId];
            const leftPlayer = room.registeredOwners.find(o => o.socketId === socket.id);
            if (leftPlayer) {
                addLogToRoom(room, 'system', `유저 [${leftPlayer.ownerName}]님이 일시적으로 통신망에서 이탈했습니다.`);
            }
        }
    });
});

const PORT = 3000;
http.listen(PORT, () => {
    console.log(`다중 방 연동 농구 서버가 포트 ${PORT}에서 작동 중입니다.`);
});
