import setuptools
import ankify_logseq

with open("README.md", "r") as fh:
    long_description = fh.read()

setuptools.setup(
    name="ankify_logseq",
    version=ankify_logseq.__version__,
    description="Bring flashcards created in a Logseq file graph to Anki (a port of ankify_roam)",
    long_description=long_description,
    long_description_content_type="text/markdown",
    packages=setuptools.find_packages(exclude=["tests", "tests.*"]),
    entry_points={
        "console_scripts": [
            "ankify_logseq=ankify_logseq.cli:main"
        ]
    },
    python_requires='>=3.9',
    install_requires=[
        "bs4",
        "requests",
    ],
)
