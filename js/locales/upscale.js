(function () {
  const text = {
    en: ['Upscale', 'Enhances each source locally before fitting. Can be slow.', 'Enhancing image'],
    'zh-CN': ['放大', '拟合前在本地增强原图。可能较慢。', '正在增强图像'],
    'zh-TW': ['放大', '擬合前在本機增強原圖。可能較慢。', '正在增強影像'],
    ja: ['拡大', '処理前に端末内で画像を補正します。時間がかかる場合があります。', '画像を補正中'],
    ko: ['확대', '도형 생성 전에 기기에서 이미지를 개선합니다. 느릴 수 있습니다.', '이미지 개선 중'],
    fr: ['Agrandissement', 'Améliore chaque image localement avant le traitement. Peut être lent.', 'Amélioration de l’image'],
    de: ['Vergrößerung', 'Verbessert jedes Bild vor der Anpassung lokal. Kann langsam sein.', 'Bild wird verbessert'],
    es: ['Ampliación', 'Mejora cada imagen localmente antes del ajuste. Puede tardar.', 'Mejorando imagen'],
    pt: ['Ampliação', 'Melhora cada imagem localmente antes do ajuste. Pode demorar.', 'Melhorando imagem'],
    ru: ['Масштабирование', 'Улучшает изображение локально перед обработкой. Может быть медленно.', 'Улучшение изображения'],
    id: ['Perbesar', 'Meningkatkan gambar secara lokal sebelum pemrosesan. Bisa lambat.', 'Meningkatkan gambar'],
    vi: ['Phóng lớn', 'Cải thiện ảnh trên thiết bị trước khi xử lý. Có thể chậm.', 'Đang cải thiện ảnh'],
    th: ['ขยายภาพ', 'ปรับปรุงภาพบนอุปกรณ์ก่อนประมวลผล อาจใช้เวลานาน', 'กำลังปรับปรุงภาพ'],
    tr: ['Büyütme', 'İşlemden önce görüntüyü cihazda iyileştirir. Yavaş olabilir.', 'Görüntü iyileştiriliyor'],
    it: ['Ingrandimento', 'Migliora ogni immagine localmente prima dell’elaborazione. Può essere lento.', 'Miglioramento immagine'],
  };
  for (const [locale, values] of Object.entries(text)) {
    const target = window.LOCALES[locale];
    if (target) ['upscale.toggle', 'upscale.hint', 'upscale.phase'].forEach((key, index) => { target[key] = values[index]; });
  }
  const limits = {
    en:'Upscaling supports sources up to 4,194,304 pixels.',
    'zh-CN':'放大支持最多 4,194,304 像素的原图。',
    'zh-TW':'放大支援最多 4,194,304 像素的原圖。',
    ja:'拡大は最大4,194,304画素の画像に対応します。',
    ko:'확대는 최대 4,194,304픽셀 원본을 지원합니다.',
    fr:'L’agrandissement accepte jusqu’à 4 194 304 pixels.',
    de:'Vergrößerung unterstützt bis zu 4.194.304 Quellpixel.',
    es:'La ampliación admite originales de hasta 4.194.304 píxeles.',
    pt:'A ampliação aceita originais de até 4.194.304 pixels.',
    ru:'Масштабирование поддерживает исходники до 4 194 304 пикселей.',
    id:'Pembesaran mendukung sumber hingga 4.194.304 piksel.',
    vi:'Phóng lớn hỗ trợ ảnh gốc tối đa 4.194.304 điểm ảnh.',
    th:'การขยายภาพ รองรับภาพต้นฉบับสูงสุด 4,194,304 พิกเซล',
    tr:'Büyütme en fazla 4.194.304 piksellik kaynakları destekler.',
    it:'L’ingrandimento supporta sorgenti fino a 4.194.304 pixel.',
  };
  for (const [locale, value] of Object.entries(limits)) window.LOCALES[locale]['upscale.limit'] = value;
  const headings = {
    en:'Enhancements', 'zh-CN':'增强', 'zh-TW':'增強', ja:'画質補正', ko:'화질 개선',
    fr:'Améliorations', de:'Verbesserungen', es:'Mejoras', pt:'Melhorias', ru:'Улучшения',
    id:'Peningkatan', vi:'Cải thiện', th:'การปรับปรุง', tr:'İyileştirmeler', it:'Miglioramenti',
  };
  for (const [locale, value] of Object.entries(headings)) window.LOCALES[locale]['upscale.enhancements'] = value;
})();
