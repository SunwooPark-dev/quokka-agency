# 🐨 Quokka Agency

**Nova 팀장 + 5 AI 전문가 병렬 협업 플랫폼**

NVIDIA NIM API 기반 6-Agent 오케스트레이션 시스템.
목표를 던지면 Nova가 업무를 분배하고, 5명의 전문가가 동시에 작업합니다.

## 팀 구성

| 에이전트 | 역할 | 모델 |
|---------|------|------|
| 🐨 Nova | 팀장 · 오케스트레이터 | nemotron-49b |
| 🔬 Kira | 분석가 | nemotron-120b |
| 🧠 Dex | 딥 리즈너 | deepseek-v3.2 |
| 💻 Max | 코더 | qwen3.5-122b |
| ✍️ Mia | 작가/전략가 | mistral-large-3 |
| 🔍 Rex | QA/리뷰어 | nemotron-253b |

## Quick Start

```bash
# 1. 설치
npm install

# 2. 환경 설정
echo "NVIDIA_API_KEY=your_key_here" > .env

# 3. 서버 실행
node server.js
# → http://localhost:3888
```

## 모델 관리 CLI

```bash
node cli/manage-models.js list       # 현재 설정
node cli/manage-models.js health     # 상태 확인
node cli/manage-models.js set <role> <model>  # 모델 변경
node cli/manage-models.js discover   # 신규 모델 탐색
node cli/manage-models.js backup     # 설정 백업
```

## 특징

- **7역할 × 3폴백 체인**: 모델이 다운되면 자동으로 대안 모델 사용
- **실시간 SSE 스트리밍**: 6개 에이전트 출력을 실시간으로 확인
- **30분 헬스체크 데몬**: 서버 기동 시 자동으로 모델 상태 모니터링
- **1시간 신규 모델 탐색**: NVIDIA NIM에서 새 모델 자동 감지
