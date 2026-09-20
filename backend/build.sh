#!/usr/bin/env sh
# Build and test the backend. Requires only a JDK (17+) — no network, no Maven.
set -e
cd "$(dirname "$0")"
rm -rf out && mkdir -p out
echo "Compiling..."
javac -d out $(find src test -name '*.java')
echo "Running tests..."
java -cp out com.inventory.EngineTest
echo
echo "Build OK.  Run the analysis report:  java -cp out com.inventory.Main"
echo "           Start the JSON API:       java -cp out com.inventory.Main --serve"
