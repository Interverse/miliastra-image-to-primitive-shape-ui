/* All fifteen supported locales; algorithm brand names are untranslated. */
(function(){
  const legacy={en:"Legacy","zh-CN":"旧版","zh-TW":"舊版",ja:"従来方式",ko:"기존 방식",fr:"Anciennes méthodes",de:"Bisherige Methoden",es:"Métodos anteriores",pt:"Métodos antigos",ru:"Прежние методы",th:"วิธีเดิม",vi:"Phương pháp cũ",id:"Metode lama",tr:"Eski yöntemler",it:"Metodi precedenti"};
  for(const [lang,text] of Object.entries(legacy))window.LOCALES[lang]["fitting.legacy"]=text;
  const hint={en:"Choose one shape.","zh-CN":"请选择一种图形。","zh-TW":"請選擇一種圖形。",ja:"図形を1種類選択。",ko:"도형 하나를 선택하세요.",fr:"Choisissez une forme.",de:"Eine Form auswählen.",es:"Elige una forma.",pt:"Escolha uma forma.",ru:"Выберите одну фигуру.",th:"เลือกรูปทรงหนึ่งชนิด",vi:"Chọn một hình.",id:"Pilih satu bentuk.",tr:"Bir şekil seçin.",it:"Scegli una forma."};
  for(const [lang,text] of Object.entries(hint))window.LOCALES[lang]["fitting.shapeHint"]=text;
  const subtitle={en:"Fit images with shapes","zh-CN":"用图形拟合图片","zh-TW":"以圖形擬合圖片",ja:"図形で画像を再現",ko:"도형으로 이미지 재현",fr:"Recréer les images avec des formes",de:"Bilder mit Formen nachbilden",es:"Recrea imágenes con formas",pt:"Recrie imagens com formas",ru:"Изображения из фигур",th:"สร้างภาพด้วยรูปทรง",vi:"Tái tạo ảnh bằng hình",id:"Bentuk gambar dari geometri",tr:"Görselleri şekillerle oluşturun",it:"Ricrea immagini con forme"};
  const batch={en:"Add several images to process a batch.","zh-CN":"添加多张图片以批量处理。","zh-TW":"加入多張圖片以批次處理。",ja:"複数の画像をまとめて処理。",ko:"여러 이미지를 추가해 일괄 처리하세요.",fr:"Ajoutez plusieurs images pour un traitement par lot.",de:"Mehrere Bilder zur Stapelverarbeitung hinzufügen.",es:"Añade varias imágenes para procesarlas por lotes.",pt:"Adicione várias imagens para processar em lote.",ru:"Добавьте несколько изображений для пакетной обработки.",th:"เพิ่มหลายภาพเพื่อประมวลผลเป็นชุด",vi:"Thêm nhiều ảnh để xử lý hàng loạt.",id:"Tambahkan beberapa gambar untuk diproses sekaligus.",tr:"Toplu işlem için birden fazla görsel ekleyin.",it:"Aggiungi più immagini per elaborarle in gruppo."};
  for(const lang of Object.keys(legacy)){
    window.LOCALES[lang]["fitting.subtitle"]=subtitle[lang];
    window.LOCALES[lang]["fitting.batch"]=batch[lang];
    window.LOCALES[lang]["fitting.formats"]="PNG / JPG / WEBP";
  }
})();
