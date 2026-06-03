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

app.get('/', (req, res) => {
    res.sendFile(__dirname + '/index.html');
});

// 방 상태 구조 관리
let roomState = {
    gameState: "SETUP",
    teamBlueName: "TEAM BLUE",
    teamRedName: "TEAM RED",
    maxBluePlayers: 5,
    maxRedPlayers: 5,
    scoreBlue: 0,
    scoreRed: 0,
    registeredOwners: [], // { team, id, ownerName, userToken, socketId, skillLevel }
    directorName: null, 
    directorToken: null,
    directorSocketId: null, 
    logs: [],
    globalDefenseLockUntil: 0 // 전역 디펜스 쿨타임 종료 타임스탬프
};

let prePauseState = "SETUP";

function addServerLog(message, type = "system") {
    const logEntry = {
        id: Date.now() + Math.random().toString(36).substr(2, 5),
        timestamp: new Date().toLocaleTimeString('ko-KR', { hour12: false }),
        message: message,
        type: type 
    };
    roomState.logs.push(logEntry);
    if (roomState.logs.length > 100) roomState.logs.shift();
    io.emit('onNewLog', logEntry);
}

io.on('connection', (socket) => {
    // 최초 접속 시 현재 방의 전체 상태 동기화 전달
    socket.emit('onInitRoomState', roomState);

    // 감독 임명 동기화 (세션 토큰 검증 추가)
    socket.on('syncRegisterDirector', (data) => {
        const { name, token } = data;
        
        // 이미 해당 토큰을 가진 감독이 새로고침한 경우 소켓 ID 갱신
        if (roomState.directorToken === token) {
            roomState.directorName = name;
            roomState.directorSocketId = socket.id;
            io.emit('onRegisterDirector', { directorName: name, directorSocketId: socket.id, directorToken: token });
            return;
        }

        // 완전히 새로운 감독 임명
        if (!roomState.directorName) {
            roomState.directorName = name;
            roomState.directorToken = token;
            roomState.directorSocketId = socket.id;
            io.emit('onRegisterDirector', { directorName: name, directorSocketId: socket.id, directorToken: token });
        }
    });

    // 매치 인원수 변경 동기화
    socket.on('syncMatchCapacity', (data) => {
        roomState.maxBluePlayers = data.blueMax;
        roomState.maxRedPlayers = data.redMax;
        io.emit('onMatchCapacityChange', data);
    });

    // 팀 실시간 이름 변경 동기화
    socket.on('syncLiveTeamName', (data) => {
        if (data.team === 'BLUE') {
            roomState.teamBlueName = data.name;
        } else {
            roomState.teamRedName = data.name;
        }
        socket.broadcast.emit('onLiveTeamName', data);
    });

    // 캐릭터 선택 동기화 (세션 토큰 매핑 포함)
    socket.on('syncRegisterOwner', (data) => {
        const { team, id, ownerName, userToken } = data;
        
        // 1. 동일한 토큰을 가진 유저가 새로고침 후 다시 연결을 시도하는지 확인
        const existingTokenIdx = roomState.registeredOwners.findIndex(p => p.userToken === userToken);
        
        if (existingTokenIdx !== -1) {
            // 기존에 잡고 있던 자리가 있다면 소켓 업데이트
            roomState.registeredOwners[existingTokenIdx].socketId = socket.id;
            io.emit('onRegisterOwner', roomState.registeredOwners[existingTokenIdx]);
            return;
        }

        // 2. 새로운 캐릭터 선택 시 자리 선점 여부 확인
        const idx = roomState.registeredOwners.findIndex(p => p.team === team && p.id === id);
        if (idx !== -1) {
            if (roomState.registeredOwners[idx].userToken === userToken) {
                roomState.registeredOwners[idx].socketId = socket.id;
                io.emit('onRegisterOwner', roomState.registeredOwners[idx]);
            }
        } else {
            // 완전히 비어있는 자리인 경우 등록
            const newOwner = {
                team: team,
                id: id,
                ownerName: ownerName,
                userToken: userToken,
                socketId: socket.id,
                skillLevel: 5.0
            };
            roomState.registeredOwners.push(newOwner);
            io.emit('onRegisterOwner', newOwner);
            addServerLog(`[입장] ${team === 'BLUE' ? '블루팀' : '레드팀'} ${id}번 캐릭터를 [${ownerName}] 유저가 선택했습니다.`);
        }
    });

    // 새로고침 유저가 소켓만 재연결되었을 때 기존 선수 데이터를 복구하기 위한 핸들러
    socket.on('reconnectPlayer', (data) => {
        const { userToken } = data;
        const found = roomState.registeredOwners.find(p => p.userToken === userToken);
        if (found) {
            found.socketId = socket.id; 
            io.emit('onRegisterOwner', found); 
        }
    });

    // 경기력 관리 값 수정 동기화
    socket.on('syncUpdateSkillLevel', (data) => {
        const found = roomState.registeredOwners.find(p => p.team === data.team && p.id === data.id);
        if (found) {
            found.skillLevel = data.skillLevel;
            io.emit('onUpdateSkillLevel', data);
            addServerLog(`[설정] ${data.team === 'BLUE' ? '블루팀' : '레드팀'} ${data.id}번(${found.ownerName})의 경기력이 v${data.skillLevel.toFixed(1)}로 조정되었습니다.`);
        }
    });

    // 경기 시작 동기화
    socket.on('syncStartGame', (data) => {
        roomState.gameState = "PLAYING";
        roomState.teamBlueName = data.teamBlueName;
        roomState.teamRedName = data.teamRedName;
        roomState.maxBluePlayers = data.maxBluePlayers;
        roomState.maxRedPlayers = data.maxRedPlayers;
        roomState.globalDefenseLockUntil = 0; // 전역 쿨타임 초기화
        io.emit('onStartGame', data);
        addServerLog(`[경기 시작] 매치가 시작되었습니다! 현재 스코어 [${roomState.scoreBlue}:${roomState.scoreRed}]`);
    });

    // 실시간 좌표 동기화
    socket.on('syncPlayerMove', (data) => {
        socket.broadcast.emit('onPlayerMove', data);
    });

    // 공 위치 및 행동 정보 동기화
    socket.on('syncBallAction', (data) => {
        socket.broadcast.emit('onBallAction', data);
    });

    // 점수 발생 동기화 및 기록
    socket.on('syncScore', (data) => {
        roomState.scoreBlue = data.blue;
        roomState.scoreRed = data.red;
        io.emit('onScoreUpdate', { blue: data.blue, red: data.red });

        const scoreTeamName = data.scoringTeam === 'BLUE' ? roomState.teamBlueName : roomState.teamRedName;
        addServerLog(`[득점] ${scoreTeamName} 팀이 2점을 추가했습니다! (현재 스코어 ${roomState.scoreBlue} : ${roomState.scoreRed})`, "score");
    });

    // 일시 정지 토글 동기화
    socket.on('syncTogglePause', () => {
        if (roomState.gameState !== "PAUSE") {
            prePauseState = roomState.gameState;
            roomState.gameState = "PAUSE";
            addServerLog(`[알림] 매치가 일시 정지되었습니다.`);
        } else {
            roomState.gameState = prePauseState;
            roomState.gameState = "PLAYING"; 
            addServerLog(`[알림] 매치가 다시 재개되었습니다.`);
        }
        io.emit('onGameStateChange', { state: roomState.gameState });
    });

    // 전체 매치 완전 초기화
    socket.on('syncResetMatch', () => {
        roomState.gameState = "SETUP";
        roomState.scoreBlue = 0;
        roomState.scoreRed = 0;
        roomState.registeredOwners = [];
        roomState.directorName = null;
        roomState.directorToken = null;
        roomState.directorSocketId = null;
        roomState.logs = [];
        roomState.globalDefenseLockUntil = 0;

        io.emit('onResetMatch');
        io.emit('onClearLogs');
    });

    // 로그 수동 초기화 동기화
    socket.on('syncClearLogs', () => {
        roomState.logs = [];
        io.emit('onClearLogs');
    });

    // 디펜스 미니게임 시작 브로드캐스트 (글로벌 쿨타임 지정 포함)
    socket.on('syncStartMiniGame', (data) => {
        roomState.gameState = "MINIGAME";
        // 디펜스가 시작되는 시점에 전역 쿨타임 3초(3000ms) 적용 예약 설정은 미니게임이 끝난 후부터 흐르도록 설정
        io.emit('onStartMiniGame', data);
    });

    // 미니게임 실시간 게이지 변동 동기화
    socket.on('syncMiniGameHit', (gauge) => {
        socket.broadcast.emit('onMiniGameGauge', gauge);
    });

    // 미니게임 완료 동기화 및 3초 전역 쿨타임 시작 타임스탬프 발행
    socket.on('syncEndMiniGame', (data) => {
        roomState.gameState = "PLAYING";
        
        // 미니게임 종료 버튼 클릭/종료 후 시점부터 3초간 전역 디펜스 금지
        const lockDuration = 3000; 
        roomState.globalDefenseLockUntil = Date.now() + lockDuration;

        if (data.isDefWin) {
            addServerLog(`[디펜스 성공] 수비가 성공하여 수비수(ID: ${data.defTeam} ${data.defId}번)가 공을 스틸했습니다!`, "defense");
        } else {
            addServerLog(`[디펜스 실패] 공격수(ID: ${data.attTeam} ${data.attId}번)가 수비를 제치고 돌파하여 공을 지켜냈습니다!`, "defense");
        }
        
        // 종료 정보와 함께 전역 쿨타임 적용 종료 타임스탬프를 클라이언트에 전달
        data.globalDefenseLockUntil = roomState.globalDefenseLockUntil;
        io.emit('onEndMiniGame', data);
    });

    // 감독 공지 메시지 송신 처리
    socket.on('sendDirectorChat', (msg) => {
        const name = roomState.directorName || "미지정";
        addServerLog(`[감독 ${name}] ${msg}`, "chat");
    });

    socket.on('disconnect', () => {
        // 새로고침 시 데이터를 파괴하지 않고 상태를 고스란히 보존합니다.
    });
});

http.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});
