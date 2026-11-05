(function(){
  const keys=['batch.pauseSave','batch.pauseSaveHint','batch.status.pausing','batch.status.paused','result.paused'];
  const text={
    en:['Pause & save','Stops processing and keeps the latest completed shapes for download.','Saving result…','Paused','Paused · {count} controls'],
    'zh-CN':['暂停并保存','停止处理，保留最新生成的形状以供下载。','正在保存结果…','已暂停','已暂停 · {count} 个控件'],
    'zh-TW':['暫停並儲存','停止處理，保留最新產生的形狀以供下載。','正在儲存結果…','已暫停','已暫停 · {count} 個控制項'],
    ja:['一時停止して保存','処理を停止し、生成済みの図形をダウンロードできるようにします。','結果を保存中…','一時停止','一時停止 · {count} 個'],
    ko:['일시 정지 및 저장','처리를 멈추고 완성된 도형을 다운로드할 수 있도록 보관합니다.','결과 저장 중…','일시 정지됨','일시 정지 · 컨트롤 {count}개'],
    fr:['Pause et enregistrer','Arrête le traitement et conserve les dernières formes terminées pour les télécharger.','Enregistrement…','En pause','En pause · {count} éléments'],
    de:['Pausieren und speichern','Stoppt die Verarbeitung und behält die zuletzt fertigen Formen zum Herunterladen.','Ergebnis wird gespeichert…','Pausiert','Pausiert · {count} Elemente'],
    es:['Pausar y guardar','Detiene el proceso y conserva las últimas formas terminadas para descargarlas.','Guardando resultado…','En pausa','En pausa · {count} controles'],
    pt:['Pausar e salvar','Interrompe o processamento e mantém as últimas formas concluídas para download.','Salvando resultado…','Pausado','Pausado · {count} controles'],
    ru:['Пауза и сохранение','Останавливает обработку и сохраняет готовые фигуры для скачивания.','Сохранение результата…','Приостановлено','Приостановлено · {count} элементов'],
    th:['หยุดและบันทึก','หยุดการประมวลผลและเก็บรูปทรงที่สร้างเสร็จล่าสุดไว้ให้ดาวน์โหลด','กำลังบันทึกผลลัพธ์…','หยุดชั่วคราว','หยุดชั่วคราว · {count} ตัวควบคุม'],
    vi:['Tạm dừng và lưu','Dừng xử lý và giữ các hình đã hoàn thành mới nhất để tải xuống.','Đang lưu kết quả…','Đã tạm dừng','Đã tạm dừng · {count} phần tử'],
    id:['Jeda dan simpan','Menghentikan proses dan menyimpan bentuk terakhir yang selesai untuk diunduh.','Menyimpan hasil…','Dijeda','Dijeda · {count} kontrol'],
    tr:['Duraklat ve kaydet','İşlemi durdurur ve tamamlanan son şekilleri indirmek için saklar.','Sonuç kaydediliyor…','Duraklatıldı','Duraklatıldı · {count} kontrol'],
    it:['Pausa e salva','Interrompe l’elaborazione e conserva le ultime forme completate per il download.','Salvataggio del risultato…','In pausa','In pausa · {count} controlli']
  };
  for(const [lang,values] of Object.entries(text))keys.forEach((key,i)=>{window.LOCALES[lang][key]=values[i];});
})();
