/* Splat method strings for all fifteen supported locales. "Splat" is a method name and stays untranslated. */
(function(){
  const text={
    en:{hint:"Uses soft-edged rectangles. Only a Lua script is made for the game, with no GIA files. You can also save the JSON.",exportNote:"Splat results can only be used in the game through the Lua script.",stat:"Soft rectangles",shape:"Soft rectangle"},
    "zh-CN":{hint:"使用柔边矩形拟合。游戏内只输出 Lua 脚本，不生成 GIA 文件。也可以保存 JSON。",exportNote:"Splat 结果只能通过 Lua 脚本在游戏中使用。",stat:"柔边矩形",shape:"柔边矩形"},
    "zh-TW":{hint:"使用柔邊矩形擬合。遊戲內只輸出 Lua 腳本，不產生 GIA 檔案。也可以儲存 JSON。",exportNote:"Splat 結果只能透過 Lua 腳本在遊戲中使用。",stat:"柔邊矩形",shape:"柔邊矩形"},
    ja:{hint:"ふちがぼけた長方形で再現します。ゲーム用に作られるのは Lua スクリプトだけで、GIA ファイルは作られません。JSON も保存できます。",exportNote:"Splat の結果は Lua スクリプトでのみゲームに使えます。",stat:"ぼかし長方形",shape:"ぼかし長方形"},
    ko:{hint:"가장자리가 부드러운 사각형을 사용합니다. 게임용으로는 Lua 스크립트만 만들어지며 GIA 파일은 없습니다. JSON도 저장할 수 있습니다.",exportNote:"Splat 결과는 Lua 스크립트로만 게임에서 사용할 수 있습니다.",stat:"부드러운 사각형",shape:"부드러운 사각형"},
    fr:{hint:"Utilise des rectangles aux bords flous. Pour le jeu, seul un script Lua est créé, sans fichier GIA. Vous pouvez aussi enregistrer le JSON.",exportNote:"Les résultats Splat ne s'utilisent dans le jeu qu'avec le script Lua.",stat:"Rectangles flous",shape:"Rectangle flou"},
    de:{hint:"Nutzt Rechtecke mit weichen Kanten. Für das Spiel wird nur ein Lua-Skript erstellt, keine GIA-Datei. Das JSON lässt sich ebenfalls speichern.",exportNote:"Splat-Ergebnisse lassen sich im Spiel nur über das Lua-Skript verwenden.",stat:"Weiche Rechtecke",shape:"Weiches Rechteck"},
    es:{hint:"Usa rectángulos de bordes suaves. Para el juego solo se crea un script Lua, sin archivos GIA. También puedes guardar el JSON.",exportNote:"Los resultados de Splat solo se pueden usar en el juego con el script Lua.",stat:"Rectángulos suaves",shape:"Rectángulo suave"},
    pt:{hint:"Usa retângulos com bordas suaves. Para o jogo, só é gerado um script Lua, sem arquivos GIA. Você também pode salvar o JSON.",exportNote:"Os resultados do Splat só podem ser usados no jogo pelo script Lua.",stat:"Retângulos suaves",shape:"Retângulo suave"},
    ru:{hint:"Использует прямоугольники с мягкими краями. Для игры создаётся только Lua-скрипт, без файлов GIA. JSON тоже можно сохранить.",exportNote:"Результаты Splat можно использовать в игре только через Lua-скрипт.",stat:"Мягкие прямоугольники",shape:"Мягкий прямоугольник"},
    th:{hint:"ใช้สี่เหลี่ยมขอบนุ่ม สำหรับเกมจะได้แค่สคริปต์ Lua เท่านั้น ไม่มีไฟล์ GIA และยังบันทึก JSON ได้ด้วย",exportNote:"ผลลัพธ์ Splat ใช้ในเกมได้ผ่านสคริปต์ Lua เท่านั้น",stat:"สี่เหลี่ยมขอบนุ่ม",shape:"สี่เหลี่ยมขอบนุ่ม"},
    vi:{hint:"Dùng hình chữ nhật viền mềm. Trong game chỉ có tập lệnh Lua, không có tệp GIA. Bạn vẫn có thể lưu JSON.",exportNote:"Kết quả Splat chỉ dùng được trong game qua tập lệnh Lua.",stat:"Hình chữ nhật viền mềm",shape:"Hình chữ nhật viền mềm"},
    id:{hint:"Memakai persegi panjang bertepi lembut. Untuk game hanya dibuat skrip Lua, tanpa file GIA. JSON juga bisa disimpan.",exportNote:"Hasil Splat hanya bisa dipakai di game lewat skrip Lua.",stat:"Persegi panjang lembut",shape:"Persegi panjang lembut"},
    tr:{hint:"Kenarları yumuşak dikdörtgenler kullanır. Oyun için yalnızca bir Lua betiği oluşturulur, GIA dosyası yoktur. JSON da kaydedilebilir.",exportNote:"Splat sonuçları oyunda yalnızca Lua betiğiyle kullanılabilir.",stat:"Yumuşak dikdörtgenler",shape:"Yumuşak dikdörtgen"},
    it:{hint:"Usa rettangoli con bordi morbidi. Per il gioco viene creato solo uno script Lua, senza file GIA. Puoi anche salvare il JSON.",exportNote:"I risultati Splat si usano nel gioco solo con lo script Lua.",stat:"Rettangoli morbidi",shape:"Rettangolo morbido"},
  };
  for(const [lang,values] of Object.entries(text))for(const [key,value] of Object.entries(values))window.LOCALES[lang]["splat."+key]=value;
})();
