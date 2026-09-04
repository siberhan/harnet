# Harnet

Harnet; Claude Code ve Codex gibi yapay zeka kodlama araçları için geliştirilmiş bir ajan orkestrasyon aracıdır. Her ajana net bir kimlik, kendi izole çalışma alanını ve diğer ajanlara görev devretme imkânı sunar.

Ajanlar birbirini doğrudan başlatmaz; onları Harnet başlatır, denetler ve sonuçları birleştirir. Çalışma alanı izolasyonu düz `git worktree` ile sağlanır.

## Temel Karar: Ajan = Canlı Bir TUI Oturumu

Harnet her ajanı gerçek interaktif TUI olarak kendi tmux oturumunda çalıştırır — ekrandaki `claude`'un aynısı, sadece görünmez bir pencerede. Oturum tek süreç ve tek yazarlıdır; `/model`, `/recap`, izin modu gibi her şey harness'ın kendi arayüzünden çalışır.

Bunun doğrudan sonuçları:

- **Harness'ın tüm arayüzü elimizde kalır.** Slash komutları, model değiştirme, izin modu döngüsü, eklenen her yeni özellik — hiçbirini Harnet'in ayrıca desteklemesi gerekmez. MVP'de bunların hiçbirini biz belirlemeyiz.
- **Oturum yönetimi ortadan kalkar.** `--session-id`, `--resume`, her çağrıda bayrakları yeniden verme, oturum çatallanması gibi sorunlar yoktur; çünkü oturum hiç kapanmaz.
- **Bedeli:** her ajan boşta dururken de canlı bir pty ve TUI tutar. Bu, eşzamanlı ajan sayısına pratik bir tavan koyar. MVP ölçeğinde sorun değildir.

### Bağlamı Harness Yönetir

Harnet ajanların bağlamını (context) kendisi kurmaz, taşımaz veya özetlemez. Ajanın hafızası, açık duran oturumun kendisidir.

- Harnet'in sakladığı geçmiş dosyası, özetleme veya prompt'a geçmiş enjeksiyonu yoktur.
- Bağlam şiştiğinde harness'ın kendi compaction mekanizması devreye girer; Harnet karışmaz.
- `session_id` yalnızca bir işaretçi olarak tutulur: transcript dosyasını bulmaya ve tamamlanma sinyallerini eşleştirmeye yarar.

## Ajanla Konuşmak

Ajan yaratılırken üç şey birlikte kurulur: kalıcı bir worktree, bir tmux oturumu ve ilk bayttan itibaren bağlanan bir `pipe-pane` günlüğü.

Harnet ajana `tmux send-keys` ile yazar, yani kullanıcının klavyesi gibi davranır. Araya giren ikinci bir süreç yoktur.

| Durum                | Claude Code         | Codex             |
| -------------------- | ------------------- | ----------------- |
| Oturumu başlatma     | `claude`            | `codex`           |
| Ajana mesaj gönderme | `tmux send-keys`    | `tmux send-keys`  |
| Tamamlanma sinyali   | `Stop` hook         | `notify` programı |
| Yapısal kayıt        | transcript `.jsonl` | rollout `.jsonl`  |

`pipe-pane` daha ilk bayt akmadan bağlandığı için "geçmiş" ile "canlı akış" diye iki ayrı kaynak yoktur; tek bir bayt günlüğü vardır. Panel açıldığında bu dosyayı okur ve izlemeye devam eder.

## Gözlem ve Tamamlanma

Gözlem iki kanaldan gelir:

- **Yapısal:** harness'ın kendi transcript jsonl dosyası — mesajlar, araç çağrıları, token ve maliyet. İş durumu, maliyet ölçümü ve raporlama buradan okunur.
- **Görsel:** `pane.log`'daki ham bayt akışı. Yalnızca insanın izlemesi içindir; Harnet buradan karar üretmez.

Görevin bittiğini ekrandan tahmin etmeyiz. Claude'un `Stop` hook'u ve Codex'in `notify`'ı tur bitince Harnet'e oturum kimliğini ve son mesajı içeren bir bildirim gönderir. Bu sinyal ölçüldü, interaktif oturumda da çalışıyor. Ekran kazıma, spinner regex'i veya polling gerekmez.

`Notification` hook'u ise ajan izin beklerken tetiklenir. Ajan onay ekranında takıldığında Harnet bunu sessiz bir bekleme değil, açık bir "insan lazım" durumu olarak kuyruğa yazar.

## Devralma

İnsan devralmak istediğinde web panelinde WebSocket üzerinden bağlanıp aynı oturumu tarayıcıda görür.

Yeni bir süreç açılmaz, ikinci bir yazar oluşmaz. Devralma bir kilit devri değil, aynı canlı oturuma bir pencere daha açmaktır — bu yüzden transcript çatallanma riski yapısal olarak yoktur.

Yine de bir davranış kuralı gerekir: insan bir ajanla konuşurken Harnet o ajana iş göndermez, kuyrukta bekletir. Bu bir veri bütünlüğü kilidi değil, iki tarafın aynı anda yazıp birbirinin cümlesini bölmemesi içindir.

## MVP Özellikleri

### Ajan Şablonları ve Profilleri

- **Ajan Şablonları:** Bir ajanın rolünü, varsayılan sistem promptunu ve araç yeteneklerini tanımlar. Yeni ajan oluşturulurken şablon seçilebilir; seçilmezse varsayılan şablon kullanılır.
- **Ajan Profilleri:** Şablondan türetilen her ajana benzersiz bir ID verilir ve adına kalıcı bir profil açılır. Profil oluşturulabilir, açılabilir, terk edilebilir veya silinebilir.

Bir profili aynı anda yalnızca bir ajan kullanır. Profil ile tmux oturumu birebir eşleşir: profil yaşadığı sürece oturum da yaşar.

Profil terk edildiğinde tmux oturumu kapatılır ama worktree ve transcript kalır; profil tekrar açıldığında yeni bir oturum başlatılır ve geçmiş sıfırdan başlar.

### Ajan Çalıştırma

Bir ajan, Harnet aracılığıyla başka bir ajanın çalıştırılmasını talep edebilir (A ajanı B'yi çağırabilir).

Harnet prompt'u B'nin canlı oturumuna `send-keys` ile yazar. B kendi worktree'si içinde çalışır; `Stop` sinyali geldiğinde Harnet transcript'ten sonucu okur, A'nın oturumuna yeni bir mesaj olarak yazar ve A çalışmaya devam eder.

#### Kontrol Servisi
Harnet arka planda çalışan sürekli bir servise ihtiyaç duyar. Bu servis `harnet up` komutuyla veya işletim sistemi düzeyinde bir servis (örneğin `launchd`) olarak çalışır.

Servis şunları yönetir:
- İş kuyruğu.
- Ajanların meşgul ve boş durumları.
- Bekleyen execute talepleri ve izin soruları.
- Ajan sonuçları.
- Profil → tmux oturumu ve `session_id` eşlemesi.

Servis, kuyruk ve durum bilgilerini bir veritabanında saklar. Servis dursa bile tmux oturumları yaşamaya devam eder; servis yeniden başladığında oturumlara yeniden bağlanır ve eski işleri sürdürür.

#### Meşguliyet
Bir ajan meşgulken ona ikinci bir iş gönderilmez; iş kuyruğa alınır. Meşguliyet, `send-keys` ile başlar ve o turun `Stop` sinyaliyle biter.

#### Çalıştırma Sonuçları ve Grup Bekleme
Bir execute çağrısı anında sonuç döndürmez; Harnet işi kabul eder, bir iş ID'si verir ve çağıran ajan turunu tamamlar.

Aynı ajan tarafından tek bir turda başlatılan tüm alt işler bir **sonuç grubu** oluşturur:
- Harnet gruptaki tüm alt işlerin tamamlanmasını bekler.
- Tüm işler bittiğinde, çağıran üst ajanı bütün sonuçlarla birlikte yalnızca bir kez uyandırır.
- Bekleyen sonuç grubu kalmamışsa ana iş tamamlanmış sayılır ve sonuç kullanıcıya raporlanır.

#### Sonuç Formatı
Bir işin sonucu, çağıran ajanın oturumuna standart bir blok olarak gönderilir:

```text
[harnet] Result from B (job 4f21, 4m 12s)
Task you sent: <A'nın B'ye gönderdiği prompt>
Status: done
Report: <B'nin çıktısı>
```

#### İş Kuyruğu ve Hatalar
Hedef ajan meşgulse Harnet işi reddetmez; o ajanın kuyruğuna ekler.

Başarısız işler de üst ajanın sonsuza kadar beklememesi için mutlaka bir sonuç üretir:
- `done`: Ajan işi tamamladı ve rapor verdi.
- `error`: Ajan turu hata bildirerek bitti.
- `timeout`: Belirlenen süre içinde `Stop` sinyali gelmedi.
- `crashed`: tmux oturumu öldü.
- `refused`: İş, izin verilen çağrı derinliği veya iş sınırını aştı.

MVP'de derinlik denetimi tek bir sabit üst sınırdan ibarettir. Döngü tespiti ve dinamik derinlik kuralları MVP sonrasına bırakılmıştır.

Başarısız işlerin kod değişiklikleri üst ajana merge edilmez, ajanın kendi branch'inde bırakılır.

### Worktree Yönetimi

Birden fazla ajanın aynı dizinde çalışması dosya çakışmalarına yol açar. Harnet her ajan profiline kendi worktree'sini verir.

#### Profil Başına Kalıcı Worktree
Her ajan profilinin sabit bir yolu ve branch'i vardır:

```text
.harnet/agents/<agent-id>/wt   →  branch: harnet/<agent-id>
```

Worktree profil oluşturulduğunda açılır, profil silinene kadar durur. Geçici worktree ve her çalıştırmada yeni worktree açan fork-on-execute mimarisi kullanılmaz.

Sebep doğrudan mimariden gelir: tmux oturumu o dizinde açılır ve ajanın tüm geçmişi o dizine ait mutlak yollarla doludur. Dizin taşınırsa oturum anlamsızlaşır.

#### Türeme
Branch'in tabanı profil oluşturulurken bir kez belirlenir ve profilin ömrü boyunca değişmez. Otomatik rebase yoktur; üst ajan ilerlediğinde alt ajanın tabanı olduğu yerde kalır ve aradaki fark teslimat sırasında `git merge` ile kapanır.
- Kullanıcının başlattığı kök ajan: taban `main`.
- Bir ajanın oluşturduğu alt ajan: taban, çağıran üst ajanın o anki branch'i. Böylece alt ajan üstün henüz `main`e girmemiş değişikliklerini görür.

#### Teslimat
- Kod akışı çağrı ağacında aşağıdan yukarıya hareket eder. Alt ajanlar işlerini ana dala değil, kendilerini çağıran üst ajana teslim eder. Yalnızca kök ajan `main`e teslimat yapar.
- Her ajan turu otomatik bir commit ile biter. Ajan çalışmadığı sürece worktree kirli kalmaz.
- Teslimat, üst ajanın uyandırılma turunda `git merge` ile yapılır.

#### Çakışma Yönetimi
Harnet çakışmaları kendisi çözmeye çalışmaz. Merge çakışırsa merge iptal edilir (`git merge --abort`), çakışan dosyaların listesi üst ajanın uyandırma promptuna eklenir ve çözüm üst ajana bırakılır. Üst ajan tüm alt sonuçları ve çakışmaları tek bir entegrasyon turunda ele alır.

### Web Arayüzü

Arayüz iki işi birden yapar: ajanları yönetmek ve gerektiğinde onların terminaline girmek.

- **Ajan ağacı ve iş kuyruğu.** Hangi ajan meşgul, hangisi bekliyor, kim kimi çağırdı.
- **Terminal.** Bir ajana tıklandığında `xterm.js` ile onun tmux oturumu açılır; ekranın tamamı, renkler, izin diyaloğu dahil. Buraya yazılan her şey `send-keys` ile ajana gider.
- **Bekleyen izin ve soru kuyruğu.** `Notification` hook'undan beslenir; hangi ajanın insan beklediğini tek bakışta gösterir.
- **Maliyet göstergesi.** Transcript'teki `usage` bloklarından tur başına token ve maliyet.

`harnet up` servisi bu arayüze HTTP + WebSocket ile hizmet eder.

### Desteklenen Ajan Harness'ları

MVP sürümünde Codex ve Claude Code desteklenecektir.

### Platform

MVP macOS ve Linux'tur; tmux'a bağımlıdır.

## MVP Sonrası Özellikler

- **Windows Desteği:** tmux'un yerine `node-pty` (Windows'ta ConPTY) ile pty'nin doğrudan Harnet sürecinde açılması. Tamamlanma sinyali pty'den bağımsız olduğu için mimarinin geri kalanı değişmez.
- **Çağrı Döngüsü Kontrolü:** MVP'deki sabit üst sınırın yerini alacak döngü tespiti ve dinamik derinlik kuralları.
- **Kaynak Yönetimi:** Uzun süre boşta kalan ajanların oturumlarını uyutup gerektiğinde geri açmak.
- **Gelişmiş Ajan Hafızası:** Ajanların dosya, komut ve bilgi parçacıklarını kaydedip arayabileceği uzun vadeli hafıza aracı.
