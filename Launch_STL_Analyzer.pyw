"""Open the fully offline STL Strength Analyzer. No third-party packages needed."""
from pathlib import Path
import webbrowser


def main():
    app = Path(__file__).resolve().with_name("STL_Strength_Analyzer.html")
    if not app.is_file():
        from tkinter import Tk, messagebox
        root = Tk()
        root.withdraw()
        messagebox.showerror(
            "STL Strength Analyzer",
            "Extract the entire ZIP first. Keep the HTML beside this launcher.",
        )
        root.destroy()
        return
    webbrowser.open(app.as_uri(), new=2)


if __name__ == "__main__":
    main()
