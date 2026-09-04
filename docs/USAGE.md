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
