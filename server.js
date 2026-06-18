const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    }
});

app.use(express.static(path.join(__dirname, 'public')));

// 기본 루트 라우터 및 미디에이터 핸들러 복구
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// 글로벌 경기 구역 저장소 (0001, 0002 등)
const roomsData = {};

// 방 초기화 및 규격 데이터 생성기
function getOrCreateRoom(roomId) {
    if (!roomsData[roomId]) {
        roomsData[roomId] = {
            gameState: "SETUP", // SETUP, PLAYING, MINIGAME, PAUSE
            scoreBlue: 0,
            scoreRed: 0,
            teamBlueName: "TEAM BLUE",
            teamRedName: "TEAM RED",
            maxBluePlayers: 5,
            maxRedPlayers: 5,
            directorName: null,
            directorToken: null,
            globalDefenseLockUntil: 0,
            miniGameGauge: 25,
            activeDefender: null,
            activeAttacker: null,
            registeredOwners: [], // { team, id, ownerName, password, socketId, x, y, angle, skillLevel }
            logs: [],
            ballState: {
                x: 500,
                y: 250,
                vx: 0,
                vy: 0,
                holderId: null,
                holderTeam: null,
                isFlying: false,
                lastShooterSkill: 5.0
            }
        };
    }
    return roomsData[roomId];
}

// 로그 시스템 모듈화
function addLog(room, type, message) {
    const now = new Date();
    const timestamp = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}:${String(now.getSeconds()).padStart(2, '0')}`;
    const logEntry = { type, message, timestamp };
    room.logs.push(logEntry);
    if (room.logs.length > 40) room.logs.shift();
    return logEntry;
}

io.on('connection', (socket) => {
    let currentRoomId = null;
    let userProfileName = null;

    // 방 진입 및 인증 처리
    socket.on('joinRoom', (data) => {
        const { roomId, userName, password, isAutoRefresh } = data;
        if (!roomId || !userName) {
            return socket.emit('authResult', { success: false, message: "방 정보 및 이름이 올바르지 않습니다." });
        }

        currentRoomId = roomId;
        userProfileName = userName;
        socket.join(roomId);

        const room = getOrCreateRoom(roomId);

        // 📌 새로고침 유저 구출 로직: 소켓 ID가 바뀌었더라도 같은 이름의 선수가 등록되어 있다면 소켓 매칭 업데이트
        const existingPlayer = room.registeredOwners.find(p => p.ownerName === userName);
        if (existingPlayer) {
            existingPlayer.socketId = socket.id;
        }

        // 감독 토큰 복구 지원
        if (room.directorName === userName && room.directorToken === "DIR_TOKEN_" + userName) {
            // 감독 권한 유지됨
        }

        socket.emit('authResult', { success: true, isAutoRefresh });
        
        // 최신 방 전체 데이터 발송 (기존 위치 및 정보 포함)
        socket.emit('onInitRoomState', room);
    });

    // 선수 포지션 등록 및 동기화
    socket.on('syncRegisterOwner', (data) => {
        if (!currentRoomId) return;
        const room = getOrCreateRoom(currentRoomId);
        
        // 중복 등록 차단 (이름 기준 예외 제어)
        const duplicate = room.registeredOwners.find(p => p.ownerName === data.ownerName);
        if (duplicate && data.ownerName !== "") return;

        // 기존 슬롯 데이터 청소 및 안전 리프레시
        room.registeredOwners = room.registeredOwners.filter(p => !(p.team === data.team && p.id === data.id));

        if (data.ownerName !== "") {
            room.registeredOwners.push({
                team: data.team,
                id: data.id,
                ownerName: data.ownerName,
                password: data.password,
                socketId: socket.id,
                x: data.x,
                y: data.y,
                angle: data.angle,
                skillLevel: 5.0
            });
            const log = addLog(room, 'chat', `${data.ownerName} 선수가 [${data.team} ${data.id}번] 자리에 등록되었습니다.`);
            io.to(currentRoomId).emit('onNewLog', log);
        }

        io.to(currentRoomId).emit('onRegisterOwner', {
            team: data.team,
            id: data.id,
            ownerName: data.ownerName,
            socketId: socket.id,
            x: data.x,
            y: data.y,
            angle: data.angle
        });
    });

    // 실시간 캐릭터 이동 좌표 수신 및 브로드캐스팅 (서버 메모리 실시간 기록)
    socket.on('syncPlayerMove', (data) => {
        if (!currentRoomId) return;
        const room = getOrCreateRoom(currentRoomId);
        const p = room.registeredOwners.find(o => o.team === data.team && o.id === data.id);
        if (p) {
            p.x = data.x;
            p.y = data.y;
            p.angle = data.angle;
        }
        socket.to(currentRoomId).emit('onPlayerMove', data);
    });

    // 공의 액션 동기화 (위치, 속도, 소유권 덤프 백업 데이터)
    socket.on('syncBallAction', (data) => {
        if (!currentRoomId) return;
        const room = getOrCreateRoom(currentRoomId);
        
        room.ballState.x = data.x;
        room.ballState.y = data.y;
        room.ballState.vx = data.vx;
        room.ballState.vy = data.vy;
        room.ballState.isFlying = data.isFlying;
        room.ballState.holderId = data.holderId || null;
        room.ballState.holderTeam = data.holderTeam || null;
        room.ballState.lastShooterSkill = data.lastShooterSkill || 5.0;

        socket.to(currentRoomId).emit('onBallAction', data);
    });

    // 경기 정원 동기화
    socket.on('syncMatchCapacity', (data) => {
        if (!currentRoomId) return;
        const room = getOrCreateRoom(currentRoomId);
        room.maxBluePlayers = data.blueMax;
        room.maxRedPlayers = data.redMax;
        io.to(currentRoomId).emit('onMatchCapacityChange', data);
    });

    // 팀 실명 명칭 변경 동기화
    socket.on('syncLiveTeamName', (data) => {
        if (!currentRoomId) return;
        const room = getOrCreateRoom(currentRoomId);
        if (data.team === "BLUE") room.teamBlueName = data.name;
        else room.teamRedName = data.name;
        socket.to(currentRoomId).emit('onLiveTeamName', data);
    });

    // 경기 시작 조율 및 초기 셋업
    socket.on('syncStartGame', (data) => {
        if (!currentRoomId) return;
        const room = getOrCreateRoom(currentRoomId);
        room.gameState = "PLAYING";
        room.teamBlueName = data.teamBlueName;
        room.teamRedName = data.teamRedName;
        room.maxBluePlayers = data.maxBluePlayers;
        room.maxRedPlayers = data.maxRedPlayers;
        room.globalDefenseLockUntil = 0;
        
        io.to(currentRoomId).emit('onStartGame', data);
        const log = addLog(room, 'score', "시합이 시작되었습니다! 매치가 진행됩니다.");
        io.to(currentRoomId).emit('onNewLog', log);
    });

    // 일시정지 제어 핸들러
    socket.on('syncTogglePause', () => {
        if (!currentRoomId) return;
        const room = getOrCreateRoom(currentRoomId);
        if (room.gameState === "PLAYING") {
            room.gameState = "PAUSE";
        } else if (room.gameState === "PAUSE") {
            room.gameState = "PLAYING";
        }
        io.to(currentRoomId).emit('onGameStateChange', { state: room.gameState });
    });

    // 매치 완전 리셋 (오직 리셋 버튼 클릭시에만 전체 데이터 메모리 소멸)
    socket.on('syncResetMatch', () => {
        if (!currentRoomId) return;
        delete roomsData[currentRoomId];
        io.to(currentRoomId).emit('onResetMatch');
    });

    // 스코어 실시간 업데이트 동기화 및 전광판 로깅
    socket.on('syncScore', (data) => {
        if (!currentRoomId) return;
        const room = getOrCreateRoom(currentRoomId);
        room.scoreBlue = data.blue;
        room.scoreRed = data.red;
        socket.to(currentRoomId).emit('onScoreUpdate', data);

        const targetTeamName = data.scoringTeam === "BLUE" ? room.teamBlueName : room.teamRedName;
        const log = addLog(room, 'score', `🎉 [득점] ${targetTeamName} 팀이 2점을 추가 달성했습니다! (${room.scoreBlue} VS ${room.scoreRed})`);
        io.to(currentRoomId).emit('onNewLog', log);
    });

    // 경기력 등급 데이터 세부 조율
    socket.on('syncUpdateSkillLevel', (data) => {
        if (!currentRoomId) return;
        const room = getOrCreateRoom(currentRoomId);
        const p = room.registeredOwners.find(o => o.team === data.team && o.id === data.id);
        if (p) {
            p.skillLevel = data.skillLevel;
            io.to(currentRoomId).emit('onUpdateSkillLevel', data);
        }
    });

    // 감독 임명 연동 및 세션 토큰 부여
    socket.on('syncRegisterDirector', (data) => {
        if (!currentRoomId) return;
        const room = getOrCreateRoom(currentRoomId);
        room.directorName = data.name;
        room.directorToken = data.token;
        io.to(currentRoomId).emit('onRegisterDirector', data);
    });

    // 디펜스 미니게임 인터셉트 시작 처리
    socket.on('syncStartMiniGame', (data) => {
        if (!currentRoomId) return;
        const room = getOrCreateRoom(currentRoomId);
        room.gameState = "MINIGAME";
        room.miniGameGauge = 25;
        room.activeDefender = { team: data.defTeam, id: data.defId };
        room.activeAttacker = { team: data.attTeam, id: data.attId };
        
        io.to(currentRoomId).emit('onStartMiniGame', data);
    });

    // 미니게임 실시간 타격/게이지 판정 코어 엔진
    socket.on('syncMiniGameHit', (role) => {
        if (!currentRoomId) return;
        const room = getOrCreateRoom(currentRoomId);
        if (room.gameState !== "MINIGAME") return;

        if (role === "DEFENDER") {
            room.miniGameGauge += 1;
        } else if (role === "ATTACKER") {
            room.miniGameGauge -= 1;
        }

        io.to(currentRoomId).emit('onMiniGameGauge', room.miniGameGauge);

        // 승패 결정 판정 경합 트리거
        if (room.miniGameGauge >= 50) {
            // 수비 승리 -> 공 소유권 강제 전환
            room.gameState = "PLAYING";
            room.globalDefenseLockUntil = Date.now() + 5000;
            
            room.ballState.holderTeam = room.activeDefender.team;
            room.ballState.holderId = room.activeDefender.id;
            room.ballState.isFlying = false;

            const log = addLog(room, 'defense', `🛡️ [수비 성공] 수비수가 압박 경합에서 승리하여 공을 탈환했습니다.`);
            io.to(currentRoomId).emit('onNewLog', log);
            io.to(currentRoomId).emit('onEndMiniGame', { 
                isDefWin: true, 
                holderTeam: room.activeDefender.team, 
                holderId: room.activeDefender.id, 
                globalDefenseLockUntil: room.globalDefenseLockUntil 
            });
        } else if (room.miniGameGauge <= 0) {
            // 공격 돌파 성공 -> 공격권 유지 및 쿨타임 패널티 부여
            room.gameState = "PLAYING";
            room.globalDefenseLockUntil = Date.now() + 5000;
            
            room.ballState.holderTeam = room.activeAttacker.team;
            room.ballState.holderId = room.activeAttacker.id;
            room.ballState.isFlying = false;

            const log = addLog(room, 'defense', `⚡ [수비 실패] 공격수가 화려한 개인기로 수비를 돌파해 냈습니다.`);
            io.to(currentRoomId).emit('onNewLog', log);
            io.to(currentRoomId).emit('onEndMiniGame', { 
                isDefWin: false, 
                holderTeam: room.activeAttacker.team, 
                holderId: room.activeAttacker.id, 
                globalDefenseLockUntil: room.globalDefenseLockUntil 
            });
        }
    });

    // 감독 전용 공지 브로드캐스팅 라우터
    socket.on('sendDirectorChat', (text) => {
        if (!currentRoomId) return;
        const room = getOrCreateRoom(currentRoomId);
        const log = addLog(room, 'chat', `📢 [알림] ${text}`);
        io.to(currentRoomId).emit('onNewLog', log);
    });

    // 전광판 로그 클리어 모듈
    socket.on('syncClearLogs', () => {
        if (!currentRoomId) return;
        const room = getOrCreateRoom(currentRoomId);
        room.logs = [];
        io.to(currentRoomId).emit('onClearLogs');
    });

    // 예외적인 끊김 처리 바인딩 (세션 데이터 보전을 위해 소켓 배열을 실시간으로 파괴하지 않음)
    socket.on('disconnect', () => {
        // 새로고침 방어 아키텍처 적용됨
    });
});

// 경기장 데이터 통합 포트 리스너 활성화
const PORT = 3000;
server.listen(PORT, () => {
    console.log(`다들 모여 매치 코어 서버 연동 완료: http://localhost:${PORT}`);
});
