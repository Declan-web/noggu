const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http);
const path = require('path');

app.use(express.static(path.join(__dirname, '')));

// 🏢 고정된 두 개의 방(0001, 0002) 상태 관리 객체 초기화
const rooms = {
    "0001": createNewRoom("0001"),
    "0002": createNewRoom("0002")
};

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
        registeredOwners: [], // { team, id, ownerName, password, socketId, skillLevel, x, y, angle }
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
    let authUserName = null;

    console.log(`[서버] 새로운 소켓 연결: ${socket.id}`);

    // 1. 방 접속 및 유저 데이터 대조 인증
    socket.on('joinRoom', (data) => {
        const roomId = data.roomId ? data.roomId.trim() : "";
        const userName = data.userName ? data.userName.trim() : "";
        const password = data.password ? data.password.trim() : "";

        if (roomId !== "0001" && roomId !== "0002") {
            socket.emit('authResult', { success: false, message: "존재하지 않는 경기 코드입니다. (0001 또는 0002 입력)" });
            return;
        }

        currentRoomId = roomId;
        authUserName = userName;
        socket.join(currentRoomId);

        const room = rooms[currentRoomId];
        console.log(`[서버] 유저 [${userName}] 방 [${currentRoomId}] 소켓 연결 수립`);

        // 계정 정보 기반 기존 등록 상태 검색 (디바이스 이전 및 세션 복구 핵심)
        let existingUser = room.registeredOwners.find(o => o.ownerName === userName);
        let myAssignedSlot = null;

        if (existingUser) {
            // 이름은 같으나 패스워드가 틀린 경우 검증 예외 처리
            if (existingUser.password !== password) {
                socket.emit('authResult', { success: false, message: "이미 등록된 이름입니다. 비밀번호를 다시 확인하세요." });
                socket.leave(currentRoomId);
                currentRoomId = null;
                authUserName = null;
                return;
            }
            // 패스워드 일치 시 신규 소켓 정보 업데이트 및 보존 처리
            existingUser.socketId = socket.id;
            myAssignedSlot = { team: existingUser.team, id: existingUser.id };
            addLogToRoom(room, 'system', `[${userName}]님이 새로운 기기로 연결을 복구했습니다.`);
        }

        // 인증 통과 신호 발송
        socket.emit('authResult', { success: true, myAssignedSlot: myAssignedSlot });

        // 클라이언트 초기 데이터 동기화 전송
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
    });

    // 2. 실시간 캐릭터 이동 동기화 및 서버 내 위치 데이터 즉시 갱신
    socket.on('syncPlayerMove', (data) => {
        if (!currentRoomId || !rooms[currentRoomId]) return;
        const room = rooms[currentRoomId];
        
        const p = room.registeredOwners.find(o => o.team === data.team && o.id === data.id);
        if (p) {
            p.x = data.x;
            p.y = data.y;
            p.angle = data.angle;
        }
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

    // 5. 캐릭터 명단 등록 및 영속 데이터 적재
    socket.on('syncRegisterOwner', (data) => {
        if (!currentRoomId || !rooms[currentRoomId]) return;
        const room = rooms[currentRoomId];

        // 중복 방지 기존 배정 정보 정리
        room.registeredOwners = room.registeredOwners.filter(
            o => !(o.team === data.team && o.id === data.id)
        );

        if (data.ownerName !== "") {
            room.registeredOwners.push({
                team: data.team,
                id: data.id,
                ownerName: data.ownerName,
                password: data.password, // 기기 유실 시 복구 인증용 패스워드
                socketId: socket.id,
                skillLevel: 5.0,
                x: data.x || 0,
                y: data.y || 0,
                angle: data.angle || 0
            });
            addLogToRoom(room, 'system', `[${data.team}] ${data.id}번에 ${data.ownerName}님이 등록되었습니다.`);
        }
        io.to(currentRoomId).emit('onRegisterOwner', data);
    });

    // 6. 팀 경기력 스킬 수정
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

    // 7. 매치 최대 인원 변경
    socket.on('syncMatchCapacity', (data) => {
        if (!currentRoomId || !rooms[currentRoomId]) return;
        const room = rooms[currentRoomId];
        room.maxBluePlayers = data.blueMax;
        room.maxRedPlayers = data.redMax;
        io.to(currentRoomId).emit('onMatchCapacityChange', data);
    });

    // 8. 실시간 팀 이름 변경
    socket.on('syncLiveTeamName', (data) => {
        if (!currentRoomId || !rooms[currentRoomId]) return;
        const room = rooms[currentRoomId];
        if (data.team === "BLUE") room.teamBlueName = data.name;
        else room.teamRedName = data.name;
        socket.to(currentRoomId).emit('onLiveTeamName', data);
    });

    // 9. 경기 공식 시작
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

    // 10. 일시정지 (PAUSE) 토글
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

    // 11. 전체 완전 초기화 (RESET) - 기록 전체 삭제
    socket.on('syncResetMatch', () => {
        if (!currentRoomId || !rooms[currentRoomId]) return;
        rooms[currentRoomId] = createNewRoom(currentRoomId);
        io.to(currentRoomId).emit('onResetMatch');
    });

    // 12. 스코어 동기화
    socket.on('syncScore', (data) => {
        if (!currentRoomId || !rooms[currentRoomId]) return;
        const room = rooms[currentRoomId];
        room.scoreBlue = data.blue;
        room.scoreRed = data.red;
        socket.to(currentRoomId).emit('onScoreUpdate', data);

        const currentScoringTeamName = data.scoringTeam === "BLUE" ? room.teamBlueName : room.teamRedName;
        addLogToRoom(room, 'score', `🎉 ${currentScoringTeamName}팀 득점! [${room.scoreBlue} : ${room.scoreRed}]`);
    });

    // 13. 미니게임 발동 시작
    socket.on('syncStartMiniGame', (data) => {
        if (!currentRoomId || !rooms[currentRoomId]) return;
        const room = rooms[currentRoomId];
        room.gameState = "MINIGAME";
        room.miniGameGauge = 50;
        room.activeDefender = { team: data.defTeam, id: data.defId };
        room.activeAttacker = { team: data.attTeam, id: data.attId };

        io.to(currentRoomId).emit('onStartMiniGame', data);
    });

    // 14. 연타 게이지 실시간 변화 축적
    socket.on('syncMiniGameHit', (gauge) => {
        if (!currentRoomId || !rooms[currentRoomId]) return;
        const room = rooms[currentRoomId];
        room.miniGameGauge = gauge;
        socket.to(currentRoomId).emit('onMiniGameGauge', gauge);
    });

    // 15. 미니게임 종료 판정
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

    // 16. 감독관 전체 공지 채팅 공지
    socket.on('sendDirectorChat', (text) => {
        if (!currentRoomId || !rooms[currentRoomId]) return;
        const room = rooms[currentRoomId];
        const name = room.directorName || "감독";
        addLogToRoom(room, 'chat', `📢 [${name}]: ${text}`);
    });

    // 17. 로그 삭제 초기화
    socket.on('syncClearLogs', () => {
        if (!currentRoomId || !rooms[currentRoomId]) return;
        const room = rooms[currentRoomId];
        room.logs = [];
        io.to(currentRoomId).emit('onClearLogs');
    });

    // 18. 접속 끊김 이벤트 핸들링 (기록 보존을 위해 방어 처리만 수행)
    socket.on('disconnect', () => {
        if (currentRoomId && rooms[currentRoomId] && authUserName) {
            const room = rooms[currentRoomId];
            addLogToRoom(room, 'system', `유저 [${authUserName}]님이 창을 닫았거나 네트워크 이탈 상태입니다.`);
        }
    });
});

const PORT = 3000;
http.listen(PORT, () => {
    console.log(`기기 변경 연동 및 세션 영속형 농구 서버가 포트 ${PORT}에서 가동 중입니다.`);
});
