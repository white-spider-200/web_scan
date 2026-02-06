#!/bin/bash

# Stop execution if any command fails
set -e

echo "[+] Updating system package lists..."
sudo apt update -y

# 1. Install System Tools (Nmap, Curl, Git, Python, Go)
echo "[+] Installing basics (Nmap, Curl, Git, Python, Go)..."
sudo apt install -y nmap curl git python3 python3-pip golang-go

# 2. Setup Go Environment for installation
export GOPATH=$HOME/go
export PATH=$PATH:$GOPATH/bin

# 3. Install Go-based Tools
# We install them to the user's Go path, then move them to /usr/local/bin
# so they are available globally without messing with your .bashrc PATH.

echo "[+] Installing Nuclei (this may take a moment)..."
go install -v github.com/projectdiscovery/nuclei/v3/cmd/nuclei@latest
sudo mv $GOPATH/bin/nuclei /usr/local/bin/

echo "[+] Installing FFUF..."
go install -v github.com/ffuf/ffuf/v2@latest
sudo mv $GOPATH/bin/ffuf /usr/local/bin/

echo "[+] Installing Gobuster..."
go install -v github.com/OJ/gobuster/v3@latest
sudo mv $GOPATH/bin/gobuster /usr/local/bin/

# 4. Install Dirsearch (Manual Install to /opt to avoid Pip errors)
echo "[+] Installing Dirsearch..."
if [ -d "/opt/dirsearch" ]; then
    echo "    Dirsearch already exists in /opt, pulling latest changes..."
    sudo git -C /opt/dirsearch pull
else
    sudo git clone https://github.com/maurosoria/dirsearch.git /opt/dirsearch
fi

# Create a symbolic link so you can just type 'dirsearch' anywhere
# (removes old link if it exists to ensure freshness)
if [ -L "/usr/local/bin/dirsearch" ]; then
    sudo rm /usr/local/bin/dirsearch
fi
sudo ln -s /opt/dirsearch/dirsearch.py /usr/local/bin/dirsearch

# 5. Verification
echo ""
echo "--------------------------------------------------"
echo "INSTALLATION COMPLETE!"
echo "--------------------------------------------------"
echo "Verifying versions:"
echo ""
echo "Nmap:      $(nmap --version | head -n 1)"
echo "Nuclei:    $(nuclei -version 2>&1 | head -n 1)"
echo "Ffuf:      $(ffuf -V)"
echo "Gobuster:  $(gobuster --version| head -n 1 )"
echo "Dirsearch: $(dirsearch --version | head -n 1)"
echo "--------------------------------------------------"
echo "You can now run all these tools from any terminal."