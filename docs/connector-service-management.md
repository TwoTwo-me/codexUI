# Connector Service Management

`codexui-connector connect` 는 **포그라운드 장기 실행 프로세스**입니다.

즉, 아래 명령은 실행 중인 동안에는 Connector를 온라인 상태로 유지하지만:

```bash
npm exec --yes --package=github:TwoTwo-me/codexUI#main -- codexui-connector connect \
  --hub https://hub.example.com \
  --connector edge-laptop \
  --token-file $HOME/.codexui-connector/edge-laptop.token
```

다음 상황에서는 같이 종료됩니다.

- SSH 세션 종료
- 터미널 종료
- 서버 재부팅
- 프로세스 크래시

그래서 **실사용 환경에서는 systemd 또는 PM2로 관리**하는 것을 권장합니다.

---

## 공통 준비

### 1. Connector 설치/토큰 준비

먼저 bootstrap token으로 설치를 끝내서 durable token 파일이 있어야 합니다.

```bash
npm exec --yes --package=github:TwoTwo-me/codexUI#main -- codexui-connector install \
  --hub https://hub.example.com \
  --connector edge-laptop \
  --token '<bootstrap-token>' \
  --token-file $HOME/.codexui-connector/edge-laptop.token
```

설치가 끝나면 현재 디렉토리에 아래 helper script 3개가 생성됩니다.

```text
./codexui-connector-edge-laptop-start.sh
./codexui-connector-edge-laptop-systemd.sh
./codexui-connector-edge-laptop-pm2.sh
```

- `start.sh` — 즉시 실행 / 재시작용
- `systemd.sh` — user systemd 등록용
- `pm2.sh` — PM2 등록용

### 2. 원격 호스트 요구사항

- Node.js 18+
- `codex` CLI 설치
- `~/.codex/auth.json` 존재
- durable token 파일 존재

---

## 방법 1: systemd

가장 권장되는 방식입니다.

장점:
- 부팅 시 자동 시작
- 프로세스 죽으면 자동 재시작
- 표준 로그 관리 (`journalctl`)
- 운영 서버에 가장 익숙한 형태

### 예시 파일

저장소에 포함된 예시:
- `docs/examples/codexui-connector.env.example`
- `docs/examples/codexui-connector.service.example`

### 권장 배치 경로

```text
/etc/codexui/edge-laptop.env
/etc/systemd/system/codexui-connector-edge-laptop.service
```

### 1. 환경 파일 생성

```bash
sudo mkdir -p /etc/codexui
sudo cp docs/examples/codexui-connector.env.example /etc/codexui/edge-laptop.env
sudo chmod 600 /etc/codexui/edge-laptop.env
```

예시 내용:

```dotenv
CODEXUI_CONNECTOR_HUB=https://hub.example.com
CODEXUI_CONNECTOR_ID=edge-laptop
CODEXUI_CONNECTOR_TOKEN_FILE=/root/.codexui-connector/edge-laptop.token
CODEXUI_CONNECTOR_ALLOW_INSECURE_HTTP=0
CODEXUI_CONNECTOR_VERBOSE=0
# CODEXUI_CONNECTOR_KEY_ID=relay-key-1
# CODEXUI_CONNECTOR_PASSPHRASE=change-me
```

### 2. 서비스 파일 설치

```bash
sudo cp docs/examples/codexui-connector.service.example /etc/systemd/system/codexui-connector-edge-laptop.service
```

필요하면 아래를 수정하세요.
- `User=`
- `WorkingDirectory=`
- `EnvironmentFile=`

### 3. 시작 및 등록

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now codexui-connector-edge-laptop
sudo systemctl status codexui-connector-edge-laptop
```

### 4. 로그 확인

```bash
sudo journalctl -u codexui-connector-edge-laptop -f
```

### 5. 재시작 / 중지

```bash
sudo systemctl restart codexui-connector-edge-laptop
sudo systemctl stop codexui-connector-edge-laptop
```

---

## 방법 2: PM2

Node 기반 환경에서 빠르게 운영하고 싶을 때 적합합니다.

장점:
- Node 사용자에게 익숙함
- 여러 Connector를 쉽게 나눠 관리 가능
- 로그/재시작 관리 간단
- non-root 사용자 운영에 편함

### 예시 파일

저장소에 포함된 예시:
- `docs/examples/codexui-connector.env.example`
- `docs/examples/codexui-connector.pm2.config.cjs`

### 1. PM2 설치

```bash
npm install -g pm2
```

### 2. 환경 파일 복사

```bash
cp docs/examples/codexui-connector.env.example ~/.codexui-connector/edge-laptop.env
chmod 600 ~/.codexui-connector/edge-laptop.env
```

### 3. PM2 설정 파일 복사

```bash
cp docs/examples/codexui-connector.pm2.config.cjs ~/codexui-connector.pm2.config.cjs
```

그리고 아래를 수정하세요.
- `name`
- `cwd`
- `envFile`
- 필요하면 `hub`, `connector id`, token 경로

### 4. 시작

```bash
pm2 start ~/codexui-connector.pm2.config.cjs
pm2 status
```

### 5. 부팅 시 자동 시작 등록

```bash
pm2 startup
pm2 save
```

### 6. 로그 확인

```bash
pm2 logs codexui-connector-edge-laptop
```

### 7. 재시작 / 중지

```bash
pm2 restart codexui-connector-edge-laptop
pm2 stop codexui-connector-edge-laptop
```

---

## 어떤 방법을 추천하나?

### systemd 추천 상황
- 리눅스 서버 운영
- 부팅 자동 복구가 중요
- 표준 서비스 방식 선호
- root/system 관리 환경

### PM2 추천 상황
- Node 앱 운영에 익숙함
- 사용자 단위로 관리하고 싶음
- 여러 Connector를 빠르게 붙였다 떼고 싶음

---

## 보안 메모

- 가능하면 **HTTPS Hub**를 사용하세요.
- HTTP Hub를 쓰는 실험 환경에서만 `--allow-insecure-http` 를 켜세요.
- token 파일은 `600` 권한 권장
- E2EE를 쓰면 `KEY_ID`, `PASSPHRASE` 를 서비스 환경에 안전하게 넣어야 합니다.
- bootstrap token이 아니라 **install 이후 durable token 파일**을 서비스가 사용해야 합니다.
