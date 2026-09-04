# Harnet Kullanım Kılavuzu

## 1. Kurulum ve Bağımlılıklar (Sıfır Bağımlılık)
Harnet çalışma zamanında (runtime) **sıfır harici bağımlılık** prensibiyle geliştirilmiştir. Ekstra bir kütüphane kurulumu ya da derleme (build) adımı gerektirmez; standart Node.js (>=18) çalışma ortamı yeterlidir.

Geliştirme, tip denetimi ve test ortamı için sadece geliştirici bağımlılıkları yüklenir:
```bash
npm ci
```

## 2. Test ve Tip Denetimi
Kod tabanı Node'un yerleşik test koşucusu ve TypeScript strict JSDoc denetimi ile korunur:

- **Birim ve Entegrasyon Testleri:**
  ```bash
  npm test
  ```
- **Statik Tip Kontrolü (`tsc --noEmit`):**
  ```bash
  npm run check
  ```
- **Birlikte Koşma:**
  ```bash
  npm test && npm run check
  ```

## 3. Yeni Ajan Oturumu (Session) Açma (3 Adım)
Harnet mimarisinde her ajan kendi izole git worktree'sinde, tek yazarlı bir tmux oturumu olarak çalışır:

1. **Worktree Açma:** Ajan için izole çalışma dizini ve kalıcı git dalını oluşturun:
   ```bash
   git worktree add -b harnet/<agent-id> .harnet/agents/<agent-id>/wt <base-branch>
   ```
2. **Tmux Oturumu Başlatma:** Ajanın worktree dizininde arka planda izole bir tmux oturumu açın:
   ```bash
   tmux new-session -d -s harnet-<agent-id> -c .harnet/agents/<agent-id>/wt "claude"
   ```
3. **Günlük Bağlama ve Mesaj Gönderme:** İlk bayttan itibaren `pipe-pane` bağlayıp ajana `send-keys` ile ilk yönergeyi iletin:
   ```bash
   tmux pipe-pane -t harnet-<agent-id> "cat > .harnet/agents/<agent-id>/pane.log"
   tmux send-keys -t harnet-<agent-id> "Merhaba, görevin..." Enter
   ```

## 4. Sürekli Servis (launchd Daemon) Yönetimi

Harnet kontrol servisi ve web paneli arka planda sürekli bir servis olarak `launchd` ile çalıştırılabilir (`node bin/harnet.js up`). Örnek şablon `examples/com.hchk.harnet.plist` dosyasında yer almaktadır.

### Kurulum (Install)
1. `examples/com.hchk.harnet.plist` içindeki dosya ve dizin yollarını (`node` yolu, proje dizini ve günlük yolları) kendi makinenize göre düzenleyin.
2. Dosyayı macOS LaunchAgents dizinine kopyalayın ve servisi etkinleştirin:
   ```bash
   cp examples/com.hchk.harnet.plist ~/Library/LaunchAgents/
   launchctl load ~/Library/LaunchAgents/com.hchk.harnet.plist
   ```
   *(Alternatif modern macOS: `launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.hchk.harnet.plist`)*

### Günlükleri İzleme (Logs)
Servisin standart çıktı ve hata akışını canlı izlemek için:
```bash
tail -f ~/Library/Logs/harnet.log
tail -f ~/Library/Logs/harnet.error.log
```

### Kaldırma (Uninstall)
Servisi durdurmak ve devre dışı bırakmak için:
```bash
launchctl unload ~/Library/LaunchAgents/com.hchk.harnet.plist
rm ~/Library/LaunchAgents/com.hchk.harnet.plist
```
*(Alternatif modern macOS: `launchctl bootout gui/$(id -u)/com.hchk.harnet`)*
