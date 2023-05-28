import os
import re

def atoi(text):
    return int(text) if text.isdigit() else text

def natural_keys(text):
    return [ atoi(c) for c in re.split(r'(\d+)', text) ]

def copy_file_names():
    current_directory = os.getcwd()
    files = os.listdir(current_directory)
    files.sort(key=natural_keys)
    
    for file_name in files:
        if file_name.endswith(".json"):
            file_name_without_extension = os.path.splitext(file_name)[0]
            print(f'"{file_name_without_extension}",')

copy_file_names()
