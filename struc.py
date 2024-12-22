import os

def print_tree(path, indent="", ignore_folders=None):
    """Рекурсивно обходит папку и выводит структуру файлов в виде дерева."""
    if ignore_folders is None:
        ignore_folders = {"node_modules", ".git"}  # Папки для игнорирования

    # Получаем список элементов в директории
    try:
        entries = os.listdir(path)
    except PermissionError:
        print(f"{indent}Нет доступа к папке: {path}")
        return

    # Проходим по каждому элементу
    for index, entry in enumerate(entries):
        full_path = os.path.join(path, entry)

        # Пропускаем папки, которые нужно игнорировать
        if entry in ignore_folders:
            continue

        # Если это директория, рекурсивно вызываем функцию для этого пути
        if os.path.isdir(full_path):
            print(f"{indent}[Директория] {entry}/")
            print_tree(full_path, indent + "    ", ignore_folders)
        else:
            print(f"{indent}[Файл] {entry}")

# Задайте путь к папке, структуру которой хотите вывести
directory_path = r"E:\Coding\HTML, JS (WEB)\AmneziaWG Config Generator\amnezia-config-gen"  # замените на нужный путь
print_tree(directory_path)
