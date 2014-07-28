#!/bin/bash
pushd .

# install motion
sudo apt-get install -y motion


# RASPBERRY PI

# dependencies
sudo apt-get install -y libjpeg62 libjpeg62-dev libavformat53 libavformat-dev libavcodec53 libavcodec-dev libavutil51 libavutil-dev libc6-dev zlib1g-dev libmysqlclient18 libmysqlclient-dev libpq5 libpq-dev

# get special release of motion 
pushd /tmp
wget https://www.dropbox.com/s/xdfcxm5hu71s97d/motion-mmal.tar.gz

# extract it
tar zxvf motion-mmal.tar.gz

# update our installation of motion
sudo mv motion /usr/bin/motion
sudo mv motion-mmalcam.conf /etc/motion.conf

# cd back to install directory
popd

# overwrite motion daemon conf to enable daemon on startup
echo "start_motion_daemon=yes" | sudo tee /etc/default/motion

# overwrite motion app conf
sudo cp motion.conf /etc/motion.conf

# set proper permissions
sudo chmod 664 /etc/motion.conf
sudo chmod 755 /usr/bin/motion
sudo touch /tmp/motion.log
sudo chmod 775 /tmp/motion.log


# iptables rule to forward traffic from port 80 to node server port
sudo iptables -t nat -A PREROUTING -p tcp --dport 80 -j REDIRECT --to-ports 3005