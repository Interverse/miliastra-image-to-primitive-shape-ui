/* Pixel-perfect method strings for all fifteen supported locales. */
(function(){
  const keys=['pixel.method','pixel.hint','pixel.loadSpeed','pixel.loadSpeedHint'];
  const text={
    en:['Pixel-perfect','Copies every pixel exactly with rectangles. Chosen automatically when the copy needs fewer than 1,000 controls (GIFs: per frame on average).','Load speed','Higher loads faster. Lower it if the game shows an execution timeout error.'],
    'zh-CN':['像素级还原','用矩形精确复制每个像素。复制所需控件少于 1,000 个时会自动选择（GIF 按每帧平均计算）。','加载速度','数值越高加载越快。如果游戏提示执行超时，请调低。'],
    'zh-TW':['像素級還原','用矩形精確複製每個像素。複製所需控制項少於 1,000 個時會自動選擇（GIF 按每幀平均計算）。','載入速度','數值越高載入越快。如果遊戲提示執行逾時，請調低。'],
    ja:['ピクセルパーフェクト','長方形ですべてのピクセルを正確に再現します。必要なコントロールが 1,000 未満なら自動で選ばれます（GIF は 1 フレームあたりの平均）。','読み込み速度','高いほど速く読み込みます。ゲームで実行タイムアウトエラーが出る場合は下げてください。'],
    ko:['픽셀 퍼펙트','사각형으로 모든 픽셀을 정확히 복사합니다. 필요한 컨트롤이 1,000개 미만이면 자동으로 선택됩니다(GIF는 프레임당 평균).','로드 속도','높을수록 빨리 로드됩니다. 게임에서 실행 시간 초과 오류가 나면 낮추세요.'],
    fr:['Pixel parfait','Copie chaque pixel exactement avec des rectangles. Choisi automatiquement si la copie nécessite moins de 1 000 contrôles (GIF : moyenne par image).','Vitesse de chargement','Plus elle est élevée, plus le chargement est rapide. Baissez-la si le jeu signale un délai d’exécution dépassé.'],
    de:['Pixelgenau','Kopiert jedes Pixel exakt mit Rechtecken. Wird automatisch gewählt, wenn die Kopie weniger als 1.000 Steuerelemente braucht (GIFs: im Schnitt pro Frame).','Ladegeschwindigkeit','Höher lädt schneller. Senken, wenn das Spiel eine Zeitüberschreitung bei der Ausführung meldet.'],
    es:['Píxel perfecto','Copia cada píxel exactamente con rectángulos. Se elige automáticamente si la copia necesita menos de 1000 controles (GIF: media por fotograma).','Velocidad de carga','Más alta carga más rápido. Bájala si el juego muestra un error de tiempo de ejecución agotado.'],
    pt:['Pixel perfeito','Copia cada pixel exatamente com retângulos. Escolhido automaticamente quando a cópia precisa de menos de 1.000 controles (GIFs: média por quadro).','Velocidade de carregamento','Mais alta carrega mais rápido. Diminua se o jogo mostrar um erro de tempo de execução esgotado.'],
    ru:['Попиксельно','Точно копирует каждый пиксель прямоугольниками. Выбирается автоматически, если копии нужно меньше 1000 элементов (GIF: в среднем на кадр).','Скорость загрузки','Чем выше, тем быстрее загрузка. Уменьшите, если игра сообщает о превышении времени выполнения.'],
    th:['พิกเซลตรงเป๊ะ','คัดลอกทุกพิกเซลอย่างแม่นยำด้วยสี่เหลี่ยม เลือกให้อัตโนมัติเมื่อสำเนาใช้ตัวควบคุมน้อยกว่า 1,000 (GIF: เฉลี่ยต่อเฟรม)','ความเร็วการโหลด','ค่าสูงโหลดเร็วขึ้น ลดค่าลงหากเกมแจ้งข้อผิดพลาดหมดเวลาการทำงาน'],
    vi:['Chính xác từng pixel','Sao chép chính xác từng pixel bằng hình chữ nhật. Tự động chọn khi bản sao cần dưới 1.000 điều khiển (GIF: trung bình mỗi khung hình).','Tốc độ tải','Càng cao tải càng nhanh. Hạ xuống nếu trò chơi báo lỗi quá thời gian thực thi.'],
    id:['Piksel sempurna','Menyalin setiap piksel secara persis dengan persegi panjang. Dipilih otomatis bila salinan butuh kurang dari 1.000 kontrol (GIF: rata-rata per bingkai).','Kecepatan muat','Makin tinggi makin cepat dimuat. Turunkan jika game menampilkan galat batas waktu eksekusi.'],
    tr:['Piksel kusursuz','Her pikseli dikdörtgenlerle birebir kopyalar. Kopya 1.000’den az kontrol gerektirdiğinde otomatik seçilir (GIF’lerde kare başına ortalama).','Yükleme hızı','Yüksek değer daha hızlı yükler. Oyun yürütme zaman aşımı hatası verirse düşürün.'],
    it:['Pixel perfetto','Copia ogni pixel esattamente con rettangoli. Scelto automaticamente se la copia richiede meno di 1.000 controlli (GIF: media per fotogramma).','Velocità di caricamento','Più alta carica più in fretta. Abbassala se il gioco segnala un timeout di esecuzione.']
  };
  for(const [lang,values] of Object.entries(text))keys.forEach((key,i)=>{window.LOCALES[lang][key]=values[i];});
})();
