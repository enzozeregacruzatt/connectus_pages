# Abre un archivo exportado con las bibliotecas de verdad, y deja sus filas en JSON. Se corre con python3 -I: el directorio de los
# archivos no debe poder cargar código.
import csv
import json
import sys
import zipfile

import openpyxl


def read_xlsx(path):
    with zipfile.ZipFile(path) as archive:
        broken = archive.testzip()
        if broken is not None:
            raise SystemExit(f'entrada dañada: {broken}')
    book = openpyxl.load_workbook(path)
    sheet = book.worksheets[0]
    rows = [['' if cell.value is None else str(cell.value) for cell in row] for row in sheet.iter_rows()]
    kinds = sorted({cell.data_type for row in sheet.iter_rows() for cell in row})
    return {'sheet': sheet.title, 'rows': rows, 'cellTypes': kinds}


def read_csv(path):
    with open(path, encoding='utf-8-sig', newline='') as file:
        return {'rows': list(csv.reader(file, delimiter=';'))}


kind, path = sys.argv[1:3]
json.dump(read_xlsx(path) if kind == 'xlsx' else read_csv(path), sys.stdout)
