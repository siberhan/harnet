# Değişiklik Günlüğü (Changelog)

Harnet projesindeki tüm önemli değişiklikler bu dosyada belgelenir.
Format [Keep a Changelog](https://keepachangelog.com/en/1.0.0/) standardına uygundur ve proje [Semantic Versioning](https://semver.org/) kurallarını takip eder.

## [0.1.0] - 2026-09-05

### Genel Bakış (MVP Sürümü)
Harnet'in ilk sürümü (v0.1.0); Claude Code ve Codex TUI oturumları üzerinde çalışan, izole Git worktree alanları ve canlı tmux oturumları ile çok ajanlı orkestrasyon sağlayan tam işlevsel MVP'yi sunar. Sıfır derleme adımı ve çalışma zamanında sıfır harici bağımlılık prensibiyle geliştirilmiştir (WebSocket panel terminali için onaylı tek istisna hariç). 333 otomatik test ile uçtan uca doğrulanmıştır.

### Eklendi (Features & Capabilities)

#### 1. Çekirdek Orkestrasyon ve İş Kuyruğu (Control Service & Queue)
- **İş Kuyruğu (`src/service/queue.js`):** Bellek içi iş kuyruğu, meşguliyet (busy state) takibi, iş kimlikleri (`jobId`) ve sonuç grupları (result groups).
- **Kontrol Servisi (`src/service/control.js`):** İş gönderimi (`submit`), dağıtımı (`dispatch`), sinyal işleme ve ebeveyn ajana tek bir uyandırma bildirimi (`wake-up`).
- **Sonuç ve Durum Modeli (`src/service/jobs.js`):** `done`, `error`, `timeout`, `crashed`, `refused` durumları ve zaman aşımı süpürücüleri (`sweepTimeouts`).
- **Kalıcı Dosya Deposu (`src/service/store.js`):** `.harnet/state/jobs.json` üzerinde durum kalıcılığı, bozuk dosya yedekleme (`.bak`) ve servis yeniden başlatmalarında kuyruk restorasyonu.
- **Profil ve Şablon Yöneticisi (`src/service/profiles.js`):** Ajan rolleri, varsayılan istemler ve yetenekler (`TEMPLATES`), worktree ve tmux oturum yaşam döngüsü (`createProfile`, `openProfile`, `abandonProfile`, `removeProfile`).

#### 2. Git Worktree ve Teslimat Yönetimi (Git & Worktree)
- **Worktree Yönetimi (`src/git/worktree.js`):** `.harnet/agents/<id>/wt` dizin düzeni ve `harnet/<id>` dalı üzerinde kalıcı çalışma alanı izolasyonu.
- **Güvenli Teslimat (`src/git/deliver.js`):** `--no-ff` ile aşağıdan yukarıya birleştirme (merge), çakışmalarda işlemi durdurma (abort) ve dosya listesiyle rapor üretme.
- **Sahte Koşucu (Fake Runner):** Gerçek git ve tmux komutları yerine test ortamlarında izole doğrulama sağlayan enjekte edilebilir runner mimarisi.

#### 3. Harness Adaptörleri ve Canlı TUI (Claude Code & Codex)
- **Claude Code Adaptörü (`src/adapters/claude.js`):** `claude` TUI başlatma, `pipe-pane` ile bayt günlüğü bağlama, `tmux send-keys` ile klavye girişi ve `Stop` hook sinyali ile tur tamamlama.
- **Codex Adaptörü (`src/adapters/codex.js`):** `codex` TUI başlatma, `notify` aracı ile tur bildirimlerini yakalama ve çalıştırma.
- **Rapor Okuyucu (`src/service/report.js`):** Stop/notify sinyali geldiğinde transcript dosyasından asenkron flush bekleme ve payload yedeği ile yarış durumlarını çözen dayanıklı okuyucu (`createReportReader`).
- **Canlı Spike ve Uçtan Uca Doğrulama:** `scripts/live-spike.sh`, `scripts/live-e2e.mjs` ve entegrasyon testleriyle canlı tmux ve harness zincirlerinin tam doğrulaması.

#### 4. Gözlem ve Transcript Çözümleme (Observation)
- **Yapısal Okuma (`src/observe/transcript.js`):** Claude ve Codex transcript JSONL dosyalarını ayrıştırma, son asistan mesajını (`turn report`) çıkarma, token kullanımını (`usage`) toplama ve bozuk satırları atlayıp devam etme.

#### 5. Web Kontrol Paneli ve Canlı Terminal (Web Panel)
- **HTTP Sunucusu (`src/panel/server.js`):**
  - `GET /api/health`: Servis sağlık kontrolü.
  - `GET /api/agents`: Canlı ajan bellekleri (`MEMORY.md`) ve durumları.
  - `GET /api/agents/<id>/tail`: Transcript dosyasının son N satırının özeti.
  - `GET /api/queue`: İş kuyruğu durumu.
  - `GET /`: Sade, tek sayfa kontrol arayüzü.
- **Canlı Terminal (WebSocket + xterm.js):**
  - `WS /api/agents/<id>/term`: Ajanın tmux `pipe-pane` günlüğünü canlı akıtma ve gelen tuş vuruşlarını `tmux send-keys` ile anında iletme.
  - Arayüzde her ajan kartına eklenen "Bağlan" düğmesi ve CDN üzerinden yüklenen sıfır paketli `xterm.js` terminal ekranı.

#### 6. İzin ve Onay Sistemi (Permissions)
- **İzin Uç Noktaları:**
  - `GET /api/permissions`: Bekleyen insan izni isteklerinin listesi (`[{ id, agentId, kind, prompt, createdAt }]`).
  - `POST /api/permissions/<id>`: Karar iletme (`{ decision: "approve" | "deny" }`).
- **Arayüz:** Web panelinde "Bekleyen İzinler" tablosu ile tek tıkla Onayla ve Reddet düğmeleri.
- **İzin Sağlayıcı (Provider) Deseni:** Servis katmanından bağımsız olarak enjekte edilebilir ve test edilebilir sağlayıcı mimarisi.

#### 7. Komut Satırı Arayüzü (CLI) ve Sürekli Servis (Daemon)
- **`bin/harnet.js status`:** `STATE.md` ve ajan `MEMORY.md` dosyalarını okuyarak konsolda biçimlendirilmiş durum tablosu basan salt-okunur CLI.
- **`bin/harnet.js up`:** Kontrol servisi, kalıcı depo ve web panelini tek komutla ayağa kaldıran, SIGINT/SIGTERM ile temiz kapanan servis komutu.
- **macOS launchd Desteği:** `examples/com.siberhan.harnet.plist` şablonu ve arka plan servis yönetimi kılavuzu (`docs/USAGE.md`).

#### 8. Dokümantasyon ve Kalite Güvencesi (Docs & CI)
- **Modül Sözleşmeleri (`docs/API.md`):** Tüm modüllerin 5 satırı aşmayan net arayüz ve imza özetleri.
- **Kullanım Kılavuzu (`docs/USAGE.md`):** Sıfır bağımlılık kurulumu, test koşumu, 3 adımda yeni ajan başlatma ve launchd daemon yönetimi.
- **GitHub Actions CI (`.github/workflows/ci.yml`):** Node.js 18, 20 ve 22 sürümlerinde `npm test` ve `npm run check` matrisi.
- **333 Test ve Katı Tip Denetimi:** JSDoc ve `tsc --noEmit` ile derleme adımsız tam tip güvenliği.
