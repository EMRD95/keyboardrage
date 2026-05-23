#!/usr/bin/env python3
"""Download flag PNGs for all languages."""
import urllib.request
from pathlib import Path

FLAGS_DIR = Path("/home/ubu/Desktop/keyboardrage/flags")

# Language → country code mapping for flagcdn.com
LANG_MAP = {
    "german": "de", "romanian": "ro", "polish": "pl",
    "norwegian_nynorsk": "no", "chinese_traditional": "tw",
    "chinese_simplified": "cn", "ukrainian": "ua", "macedonian": "mk",
    "esperanto": "eo", "esperanto_x_sistemo": "eo",
    "esperanto_h_sistemo": "eo", "thai": "th", "greek": "gr",
    "finnish": "fi", "czech": "cz", "persian": "ir",
    "danish": "dk", "indonesian": "id", "korean": "kr",
    "belarusian": "by", "serbian_latin": "rs", "serbian": "rs",
    "vietnamese": "vn", "turkish": "tr", "dutch": "nl",
    "hebrew": "il", "bosnian": "ba", "uzbek": "uz",
    "occitan": "es-ct",  # Catalonia as closest
    "estonian": "ee", "slovak": "sk", "hungarian": "hu",
    "bangla": "bd", "afrikaans": "za", "urdu": "pk",
    "portuguese_acentos_e_cedilha": "pt",
    "lithuanian": "lt", "mongolian": "mn", "slovenian": "si",
    "swedish": "se", "xhosa": "za",  # South Africa
    "croatian": "hr",
    # Already have
    "english": "gb", "french": "fr", "italian": "it",
    "spanish": "es", "portuguese": "pt", "russian": "ru",
}

def download_flag(code, lang_name):
    url = f"https://flagcdn.com/w80/{code}.png"
    out = FLAGS_DIR / f"{lang_name}.png"
    try:
        urllib.request.urlretrieve(url, out)
        size = out.stat().st_size
        print(f"  {lang_name}: {code} → {size}B")
        return True
    except Exception as e:
        print(f"  {lang_name}: {code} → FAILED ({e})")
        return False

# Download all
for lang, code in sorted(LANG_MAP.items()):
    download_flag(code, lang)
