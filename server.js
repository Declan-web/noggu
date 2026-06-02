const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http, {
    cors: {
        origin: "*",
        methods: [["GET", "POST"]]
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
    registeredOwners: [],
    directorName: null, 
    directorSocketId: null, 
    logs: [] 
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

    // 감독 임명 동기화
    socket.on('syncRegisterDirector', (name) => {
        if (!roomState.directorName) {
            roomState.directorName = name;
            roomState.directorSocketId = socket.id;
            io.emit('onRegisterDirector', { directorName: name, directorSocketId: socket.id });
            addServerLog(`[임명] [${name}] 님이 이 매치의 공식 감독관으로 취임했습니다.`);
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

    // 캐릭터 선택 동기화
    socket.on('syncRegisterOwner', (data) => {
        const idx = roomState.registeredOwners.findIndex(p => p.team === data.team && p.id === data.id);
        if (idx !== -1) {
            roomState.registeredOwners[idx].ownerName = data.ownerName;
            roomState.registeredOwners[idx].socketId = socket.id;
        } else {
            roomState.registeredOwners.push({
                team: data.team,
                id: data.id,
                ownerName: data.ownerName,
                socketId: socket.id,
                skillLevel: 5.0
            });
        }
        io.emit('onRegisterOwner', { team: data.team, id: data.id, ownerName: data.ownerName, socketId: socket.id });
        addServerLog(`[입장] ${data.team === 'BLUE' ? '블루팀' : '레드팀'} ${data.id}번 캐릭터를 [${data.ownerName}] 유저가 선택했습니다.`);
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
        io.emit('onStartGame', data);
        addServerLog(`[경기 시작] 매치가 시작되었습니다! 현재 스코어 [${roomState.scoreBlue}:${roomState.scoreRed}]`);
    });

    // 실시간 좌표 동기화 (트래픽 경감을 위해 broadcast 처리)
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
            addServerLog(`[알림] 매치가 다시 재개되었습니다.`);
        }
        io.emit('onGameStateChange', { state: roomState.gameState });
    });

    // 전체 매치 완전 초기화 (감독 정보, 유저 할당, 로그, 스코어 올 리셋)
    socket.on('syncResetMatch', () => {
        roomState.gameState = "SETUP";
        roomState.scoreBlue = 0;
        roomState.scoreRed = 0;
        roomState.registeredOwners = [];
        roomState.directorName = null;
        roomState.directorSocketId = null;
        roomState.logs = [];

        // 모든 소켓에 초기화 상태 강제 동기화
        io.emit('onResetMatch');
        io.emit('onClearLogs');
        
        // 새로고침된 깔끔한 로그창에 첫 시작 공지만 기록
        addServerLog(`[매치 초기화] 모든 경기 데이터, 감독 직위, 선택된 선수들이 완전히 초기화되었습니다.`);
    });

    // 로그 수동 초기화 동기화
    socket.on('syncClearLogs', () => {
        roomState.logs = [];
        io.emit('onClearLogs');
    });

    // 디펜스 미니게임 시작 브로드캐스트
    socket.on('syncStartMiniGame', (data) => {
        roomState.gameState = "MINIGAME";
        io.emit('onStartMiniGame', data);
    });

    // 미니게임 실시간 타격 동기화
    socket.on('syncMiniGameHit', (gauge) => {
        socket.broadcast.emit('onMiniGameGauge', gauge);
    });

    // 미니게임 완료 동기화
    socket.on('syncEndMiniGame', (data) => {
        roomState.gameState = "PLAYING";
        if (data.isDefWin) {
            addServerLog(`[디펜스 성공] 수비가 성공하여 수비수(ID: ${data.defTeam} ${data.defId}번)가 공을 스틸했습니다!`, "defense");
        } else {
            addServerLog(`[디펜스 실패] 공격수(ID: ${data.attTeam} ${data.attId}번)가 수비를 제치고 돌파하여 공을 지켜냈습니다!`, "defense");
        }
        io.emit('onEndMiniGame', data);
    });

    // 감독 공지 메시지 송신 처리
    socket.on('sendDirectorChat', (msg) => {
        const name = roomState.directorName || "미지정";
        addServerLog(`[감독 ${name}] ${msg}`, "chat");
    });

    // 퇴장(새로고침 등) 시 선수 및 감독 유지 요청에 따라 자동 파괴 로직 제거
    socket.on('disconnect', () => {
        // [수정사항] 새로고침해도 퇴장 처리하거나 자동 파괴 공지를 띄우지 않고 그대로 복구 가능하도록 유지합니다.
    });
});

http.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});
