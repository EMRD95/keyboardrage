import json
from collections import OrderedDict
import glob

def calculate_avg_word_length(words):
    total_length = sum(len(word.strip()) for word in words)
    return round(total_length / len(words), 1)

def update_json_files():
    json_files = glob.glob('*.json')

    for file_name in json_files:
        with open(file_name, 'r', encoding='utf-8') as json_file:
            data = json.load(json_file, object_pairs_hook=OrderedDict)

        avg_word_length = calculate_avg_word_length(data['words'])

        new_data = OrderedDict()
        new_data['name'] = data.get('name')
        new_data['charLength'] = avg_word_length
        if data.get('noLazyMode') is not None:
            new_data['noLazyMode'] = data.get('noLazyMode')
        if data.get('orderedByFrequency') is not None:
            new_data['orderedByFrequency'] = data.get('orderedByFrequency')
        new_data['words'] = data.get('words')

        with open(file_name, 'w', encoding='utf-8') as json_file:
            json.dump(new_data, json_file, indent=2, ensure_ascii=False)

update_json_files()
