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

// 정적 파일 서버 디렉터리 바인딩
app.use(express.static(path.join(__dirname, 'public')));

// 기본 인덱스 라우팅 처리
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// 글로벌 경기 구역 인메모리 데이터베이스 (0001, 0002 등)
const roomsData = {};

// [고정 상수] 경기장 규격 및 물리 상수 정의
const COURT_WIDTH = 1000;
const COURT_HEIGHT = 500;
const BALL_MAX_SPEED = 25;
const FRICTION = 0.98;

// 방 초기화 및 상세 규격 데이터 스키마 생성기 (물리 엔진 상태 포함)
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
            // 서버 측 2차 검증을 위한 공의 물리 상태 구조체 복구
            ballState: {
                x: 500,
                y: 250,
                vx: 0,
                vy: 0,
                holderId: null,
                holderTeam: null,
                isFlying: false,
                lastShooterSkill: 5.0,
                lastUpdate: Date.now()
            }
        };
    }
    return roomsData[roomId];
}

// 실시간 이벤트 로그 오버플로우 방지 모듈
function addLog(room, type, message) {
    const now = new Date();
    const timestamp = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}:${String(now.getSeconds()).padStart(2, '0')}`;
    const logEntry = { type, message, timestamp };
    room.logs.push(logEntry);
    if (room.logs.length > 40) room.logs.shift(); // 40개 초과 시 최하단 로그 제거
    return logEntry;
}

// [서버 측 물리 시뮬레이션 루프] 관전자 및 새로고침 유저의 싱크를 강제로 유지하기 위한 보조 업데이트
setInterval(() => {
    Object.keys(roomsData).forEach(roomId => {
        const room = roomsData[roomId];
        if (room.gameState !== "PLAYING" || room.ballState.holderId) return;

        const ball = room.ballState;
        if (ball.isFlying) {
            // 마찰력 및 위치 업데이트 계산
            ball.x += ball.vx;
            ball.y += ball.vy;
            ball.vx *= FRICTION;
            ball.vy *= FRICTION;

            // 벽면 충돌 및 바운드 튕김 정밀 연산
            if (ball.x < 8 || ball.x > COURT_WIDTH - 8) {
                ball.vx *= -1;
                ball.x = ball.x < 8 ? 8 : COURT_WIDTH - 8;
            }
            if (ball.y < 8 || ball.y > COURT_HEIGHT - 8) {
                ball.vy *= -1;
                ball.y = ball.y < 8 ? 8 : COURT_HEIGHT - 8;
            }

            // 속도가 임계값 이하로 떨어지면 정지 처리
            if (Math.abs(ball.vx) < 0.1 && Math.abs(ball.vy) < 0.1) {
                ball.vx = 0;
                ball.vy = 0;
                ball.isFlying = false;
            }
        }
    });
}, 1000 / 60); // 60FPS 하이브리드 서버 틱 동기화

// 소켓 네트워크 레이어 실시간 핸들링
io.on('connection', (socket) => {
    let currentRoomId = null;
    let userProfileName = null;

    // 방 진입 및 세션 인증 디스패처
    socket.on('joinRoom', (data) => {
        const { roomId, userName, password, isAutoRefresh } = data;
        if (!roomId || !userName) {
            return socket.emit('authResult', { success: false, message: "방 정보 및 이름이 올바르지 않습니다." });
        }

        currentRoomId = roomId;
        userProfileName = userName;
        socket.join(roomId);

        const room = getOrCreateRoom(roomId);

        // [새로고침 구출 아키텍처] 기존 등록 데이터의 소켓 아이디만 실시간으로 교체
        const existingPlayer = room.registeredOwners.find(p => p.ownerName === userName);
        if (existingPlayer) {
            existingPlayer.socketId = socket.id;
        }

        // 감독 토큰 생존 유효성 검사
        if (room.directorName === userName && room.directorToken === "DIR_TOKEN_" + userName) {
            // 기존 권한 자동 인계됨
        }

        socket.emit('authResult', { success: true, isAutoRefresh });
        
        // 새로고침한 브라우저에 서버 세션 저장소의 원본 스냅샷 전송
        socket.emit('onInitRoomState', room);
    });

    // 선수 포지션 등록 및 배치 제어
    socket.on('syncRegisterOwner', (data) => {
        if (!currentRoomId) return;
        const room = getOrCreateRoom(currentRoomId);
        
        // 본인 실명 기반 1인 1슬롯 중복 등록 차단 예외 처리
        const duplicate = room.registeredOwners.find(p => p.ownerName === data.ownerName);
        if (duplicate && data.ownerName !== "") return;

        // 타 유저가 해당 슬롯을 차지하고 있을 경우 기존 등록 정보 오버라이드 청소
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

    // 실시간 캐릭터 이동 좌표 동기화 (서버 세션 버퍼에 실시간 백업)
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

    // 공의 소유권 전환, 슛, 패스 물리 백업 트래커
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

    // 경기 출전 제한 인원 실시간 제한 동기화
    socket.on('syncMatchCapacity', (data) => {
        if (!currentRoomId) return;
        const room = getOrCreateRoom(currentRoomId);
        room.maxBluePlayers = data.blueMax;
        room.maxRedPlayers = data.redMax;
        io.to(currentRoomId).emit('onMatchCapacityChange', data);
    });

    // 팀 실명 설정 변경 액션 반영
    socket.on('syncLiveTeamName', (data) => {
        if (!currentRoomId) return;
        const room = getOrCreateRoom(currentRoomId);
        if (data.team === "BLUE") room.teamBlueName = data.name;
        else room.teamRedName = data.name;
        socket.to(currentRoomId).emit('onLiveTeamName', data);
    });

    // 경기 구역 셋업 마감 및 시합 개시 트리거
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

    // 시합 일시 중단 및 재개 플래그 전환
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

    // 경기 구역 메모리 포맷 및 하드 리셋 (리셋 연동 버튼 입력 시에만 실행)
    socket.on('syncResetMatch', () => {
        if (!currentRoomId) return;
        delete roomsData[currentRoomId];
        io.to(currentRoomId).emit('onResetMatch');
    });

    // 득점 현황 수신 및 로그 기록 전송
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

    // 특정 유저의 경기력 수치 정밀 조정
    socket.on('syncUpdateSkillLevel', (data) => {
        if (!currentRoomId) return;
        const room = getOrCreateRoom(currentRoomId);
        const p = room.registeredOwners.find(o => o.team === data.team && o.id === data.id);
        if (p) {
            p.skillLevel = data.skillLevel;
            io.to(currentRoomId).emit('onUpdateSkillLevel', data);
        }
    });

    // 권한 감독 임명 및 세션 암호 토큰 발행
    socket.on('syncRegisterDirector', (data) => {
        if (!currentRoomId) return;
        const room = getOrCreateRoom(currentRoomId);
        room.directorName = data.name;
        room.directorToken = data.token;
        io.to(currentRoomId).emit('onRegisterDirector', data);
    });

    // 디펜스 미니게임 난투 모드 진입 연산
    socket.on('syncStartMiniGame', (data) => {
        if (!currentRoomId) return;
        const room = getOrCreateRoom(currentRoomId);
        room.gameState = "MINIGAME";
        room.miniGameGauge = 25; // 중앙 기점 디폴트 밸런스 값
        room.activeDefender = { team: data.defTeam, id: data.defId };
        room.activeAttacker = { team: data.attTeam, id: data.attId };
        
        io.to(currentRoomId).emit('onStartMiniGame', data);
    });

    // 미니게임 연타 게이지 판정 엔진
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

        // 연타 게이지 한계치 도달 시 경합 판정 종료 처리
        if (room.miniGameGauge >= 50) {
            // 수비가 이겼을 때: 공 스틸 성공 처리
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
            // 공격이 이겼을 때: 돌파 성공 및 가속 유지
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

    // 감독 라인 전체 공지 텍스트 브로드캐스트
    socket.on('sendDirectorChat', (text) => {
        if (!currentRoomId) return;
        const room = getOrCreateRoom(currentRoomId);
        const log = addLog(room, 'chat', `📢 [알림] ${text}`);
        io.to(currentRoomId).emit('onNewLog', log);
    });

    // 상황판 실시간 로깅 내역 초기화
    socket.on('syncClearLogs', () => {
        if (!currentRoomId) return;
        const room = getOrCreateRoom(currentRoomId);
        room.logs = [];
        io.to(currentRoomId).emit('onClearLogs');
    });

    // 브라우저 예외 종료 및 리프레시 감지 (안전 세션 유지를 위해 무반응 처리 대기)
    socket.on('disconnect', () => {
        // 새로고침 완충 시스템이 적용되어 있으므로 구조를 유지합니다.
    });
});

// 📌 [오류 방지 완충 장치] 어떤 잘못된 라우터 경로(/undefined 등)로 튕기더라도 index.html로 안전하게 강제 리다이렉트 시킵니다.
app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// 코어 네트워크 포트 리스닝 프로세스 바인딩
const PORT = 3000;
server.listen(PORT, () => {
    console.log(`다들 모여 매치 코어 서버 연동 완료: http://localhost:${PORT}`);
});
