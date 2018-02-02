# fiware/stream-oriented-kurento
# Based on https://github.com/Kurento/kurento-docker/blob/master/docker/Dockerfile

FROM      ubuntu:14.04
MAINTAINER Patxi Gortázar <patxi.gortazar@gmail.com>

RUN apt-get update \
  && apt-get -y dist-upgrade \
	&& apt-get install -y wget
#
# # Required for H264
RUN apt-get -y install libglib2.0-0

RUN	echo "deb http://ubuntu.kurento.org/ trusty kms6" | tee /etc/apt/sources.list.d/kurento.list \
	&& wget -O - http://ubuntu.kurento.org/kurento.gpg.key | apt-key add - \
	&& apt-get update \
	&& apt-get -y install kurento-media-server-6.0 \
  && apt-get -y install openh264-gst-plugins-bad-1.5 \
	&& apt-get clean \
  && rm -rf /var/lib/apt/lists/*

EXPOSE 8888

COPY ./entrypoint.sh /entrypoint.sh
COPY ./SdpEndpoint.conf.json /etc/kurento/modules/kurento/SdpEndpoint.conf.json

ENV GST_DEBUG=Kurento*:5
