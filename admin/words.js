/*global systemDictionary:true */
'use strict';

systemDictionary = {
    "SENEC adapter settings": {
        "en": "SENEC adapter settings",
        "de": "SENEC-Adaptereinstellungen",
        "ru": "Настройки адаптера SENEC",
        "pt": "Configurações do adaptador SENEC",
        "nl": "SENEC-adapterinstellingen",
        "fr": "Paramètres de l'adaptateur SENEC",
        "it": "Impostazioni dell'adattatore SENEC",
        "es": "Configuración del adaptador SENEC",
        "pl": "Ustawienia adaptera SENEC",
        "zh-cn": "SENEC适配器设置"
    },
    "IP / FQDN of SENEC System": {
        "en": "IP / FQDN of SENEC System",
        "de": "IP / FQDN des SENEC-Systems",
        "ru": "IP / FQDN системы SENEC",
        "pt": "IP / FQDN do sistema SENEC",
        "nl": "IP / FQDN van SENEC-systeem",
        "fr": "IP / FQDN du système SENEC",
        "it": "IP / FQDN del sistema SENEC",
        "es": "IP / FQDN del sistema SENEC",
        "pl": "Adres IP / FQDN systemu SENEC",
        "zh-cn": "SENEC系统的IP / FQDN"
    },
    "Polling Interval (seconds)": {
        "en": "Polling Interval (seconds)",
        "de": "Abfrageintervall (Sekunden)",
        "ru": "Интервал опроса (секунды)",
        "pt": "Intervalo de pesquisa (segundos)",
        "nl": "Polling-interval (seconden)",
        "fr": "Intervalle d'interrogation (secondes)",
        "it": "Intervallo di polling (secondi)",
        "es": "Intervalo de sondeo (segundos)",
        "pl": "Interwał odpytywania (sekundy)",
        "zh-cn": "轮询间隔（秒）"
    },
	  "Here you can define the polling interval [min 1, max 3600 seconds]. Default = 10.": {
    "en": "Here you can define the polling interval [min 1, max 3600 seconds]. Default = 10.",
    "de": "Hier können Sie das Abfrageintervall definieren [min 1, max 3600 Sekunden]. Standard = 10.",
    "ru": "Здесь вы можете определить интервал опроса [мин 1, макс 3600 секунд]. По умолчанию = 10.",
    "pt": "Aqui você pode definir o intervalo de pesquisa [min 1, max 3600 segundos]. Padrão = 10.",
    "nl": "Hier kunt u het polling-interval definiëren [min 1, max 3600 seconden]. Standaard = 10.",
    "fr": "Ici, vous pouvez définir l'intervalle d'interrogation [min 1, max 3600 secondes]. Par défaut = 10.",
    "it": "Qui è possibile definire l'intervallo di polling [min 1, max 3600 secondi]. Predefinito = 10.",
    "es": "Aquí puede definir el intervalo de sondeo [mínimo 1, máximo 3600 segundos]. Por defecto = 10.",
    "pl": "Tutaj możesz zdefiniować interwał odpytywania [min 1, max 3600 sekund]. Domyślnie = 10.",
    "zh-cn": "在这里，您可以定义轮询间隔[最小1，最大3600秒]。默认值= 10"
  },
	"Here you enter the IP or FQDN of your SENEC System": {
		"en": "Here you enter the IP or FQDN of your SENEC System",
		"de": "Hier geben Sie die IP oder FQDN Ihres SENEC-Systems ein",
		"ru": "Здесь вы вводите IP или полное доменное имя вашей системы SENEC",
		"pt": "Aqui você digita o IP ou FQDN do seu sistema SENEC",
		"nl": "Hier voert u de IP of FQDN van uw SENEC-systeem in",
		"fr": "Ici, vous entrez l'IP ou le FQDN de votre système SENEC",
		"it": "Qui inserisci l'IP o il nome FQDN del tuo sistema SENEC",
		"es": "Aquí ingresa la IP o FQDN de su sistema SENEC",
		"pl": "Tutaj wprowadź adres IP lub nazwę FQDN swojego systemu SENEC",
		"zh-cn": "在这里输入SENEC系统的IP或FQDN"
	},
	  "Polling Retries": {
    "en": "Polling Retries",
    "de": "Wiederholungsversuche",
    "ru": "Повторные попытки",
    "pt": "Tentativas de sondagem",
    "nl": "Polling pogingen",
    "fr": "Relance des interrogations",
    "it": "Tentativi di polling",
    "es": "Reintentos de sondeo",
    "pl": "Ponawia próbę odpytywania",
    "zh-cn": "轮询重试"
  },
      "Here you enter how often you want the adapter to retry polling in case of error [min 0, max 999]. 0 = never, 999 = unlimited. Default = 10.": {
    "en": "Here you enter how often you want the adapter to retry polling in case of error [min 0, max 999]. 0 = never, 999 = unlimited. Default = 10.",
    "de": "Hier geben Sie an, wie oft der Adapter im Fehlerfall die Abfrage wiederholen soll [min 0, max 999]. 0 = nie, 999 = unbegrenzt. Standard = 10.",
    "ru": "Здесь вы вводите, как часто вы хотите, чтобы адаптер повторил опрос в случае ошибки [min 0, max 999]. 0 = никогда, 999 = неограниченно. По умолчанию = 10.",
    "pt": "Aqui, você insere com que frequência deseja que o adaptador tente novamente a pesquisa em caso de erro [min 0, máximo 999]. 0 = nunca, 999 = ilimitado. Padrão = 10.",
    "nl": "Hier geeft u op hoe vaak u wilt dat de adapter polling opnieuw probeert in geval van een fout [min 0, max 999]. 0 = nooit, 999 = onbeperkt. Standaard = 10.",
    "fr": "Vous saisissez ici la fréquence à laquelle vous souhaitez que l'adaptateur relance l'interrogation en cas d'erreur [min 0, max 999]. 0 = jamais, 999 = illimité. Par défaut = 10.",
    "it": "Qui inserisci la frequenza con cui desideri che l'adattatore riprova a eseguire il polling in caso di errore [min 0, max 999]. 0 = mai, 999 = illimitato. Predefinito = 10.",
    "es": "Aquí ingresa con qué frecuencia desea que el adaptador vuelva a intentar el sondeo en caso de error [min 0, max 999]. 0 = nunca, 999 = ilimitado. Por defecto = 10.",
    "pl": "Tutaj wprowadź, jak często adapter ma ponawiać próbę odpytywania w przypadku błędu [min. 0, maks. 999]. 0 = nigdy, 999 = nieograniczony. Domyślnie = 10.",
    "zh-cn": "在此输入发生错误[最小0，最大999]时适配器重试轮询的频率。 0 =永不，999 =无限。默认值= 10。"
  },
    "Polling Retry Factor": {
    "en": "Polling Retry Factor",
    "de": "Polling-Wiederholungsfaktor",
    "ru": "Коэффициент повтора опроса",
    "pt": "Fator de Nova Tentativa de Pesquisa",
    "nl": "Polling Retry Factor",
    "fr": "Facteur de nouvelle tentative d'interrogation",
    "it": "Fattore di tentativo di polling",
    "es": "Factor de reintento de sondeo",
    "pl": "Współczynnik ponownej próbkowania",
    "zh-cn": "轮询重试因子"
  },
      "Here you enter how you want to space retries apart of each other. n'th retry will happen after Interval * Multiplier * n seconds. [min 1, max 10]. Default = 2.": {
    "en": "Here you enter how you want to space retries apart of each other. n'th retry will happen after Interval * Multiplier * n seconds. [min 1, max 10]. Default = 2.",
    "de": "Hier geben Sie ein, wie sich der zeitliche Abstand zwischen den Wiederholungsversuchen verhält. Der n-te Wiederholungsversuch erfolgt nach Intervall * Multiplikator * n Sekunden. [min 1, max 10]. Standard = 2. ",
    "ru": "Здесь вы вводите, как вы хотите, чтобы интервалы повторялись друг от друга. n-я повторная попытка произойдет через интервал *множитель* n секунд. [мин 1, макс 10]. По умолчанию = 2. ",
    "pt": "Aqui você digita como deseja espaçar as tentativas uma da outra. a enésima nova tentativa ocorrerá após o Intervalo *Multiplicador* n segundos. [min 1, max 10]. Padrão = 2. ",
    "nl": "Hier geeft u op hoe u pogingen uit elkaar wilt plaatsen. de nieuwe poging zal gebeuren na Interval *Multiplier* n seconden. [min 1, max 10]. Standaard = 2. ",
    "fr": "Vous saisissez ici comment vous souhaitez espacer les tentatives les unes des autres. La sixième tentative ne se produira qu'après Intervalle *Multiplicateur* n secondes. [min 1, max 10]. Par défaut = 2. ",
    "it": "Qui si inserisce il modo in cui si desidera separare i tentativi uno dall'altro. l'ennesimo tentativo avverrà dopo l'intervallo *moltiplicatore* n secondi. [min 1, max 10]. Predefinito = 2. ",
    "es": "Aquí ingresa cómo desea espaciar los reintentos uno del otro. el enésimo reintento ocurrirá después del Intervalo *Multiplicador* n segundos. [mínimo 1, máximo 10]. Por defecto = 2. ",
    "pl": "Tutaj podajesz, w jaki sposób chcesz umieścić odstępy między sobą. n-ta próba nastąpi po przerwie *Mnożnik* n sekund. [min 1, maks. 10]. Domyślnie = 2. ",
    "zh-cn": "在这里，您可以输入相互重试间隔的方式。第n次重试将在间隔*乘数* n秒后发生。 [最小1，最大10]。默认值= 2。"
  },
    "Request-Timeout (ms)": {
    "en": "Request-Timeout (ms)",
    "de": "Request-Timeout (ms)",
    "ru": "Время ожидания запроса (мс)",
    "pt": "Tempo limite da solicitação (ms)",
    "nl": "Verzoek-time-out (ms)",
    "fr": "Délai d'expiration de la demande (ms)",
    "it": "Request-Timeout (ms)",
    "es": "Solicitud de tiempo de espera (ms)",
    "pl": "Limit czasu żądania (ms)",
    "zh-cn": "请求超时（毫秒）"
  },
      "Here you define the request timeout when polling from SENEC [min 1000, max 100000]. Default = 5000.": {
    "en": "Here you define the request timeout when polling from SENEC [min 1000, max 100000]. Default = 5000.",
    "de": "Hier definieren Sie das Anforderungszeitlimit beim Abrufen von SENEC [min 1000, max 100000]. Standard = 5000.",
    "ru": "Здесь вы определяете время ожидания запроса при опросе от SENEC [min 1000, max 100000]. По умолчанию = 5000.",
    "pt": "Aqui você define o tempo limite da solicitação ao pesquisar no SENEC [min 1000, max 100000]. Padrão = 5000.",
    "nl": "Hier definieert u de time-out van het verzoek bij polling vanuit SENEC [min 1000, max 100000]. Standaard = 5000.",
    "fr": "Vous définissez ici le délai d'expiration de la requête lors de l'interrogation à partir de SENEC [min 1000, max 100000]. Par défaut = 5000.",
    "it": "Qui si definisce il timeout della richiesta durante il polling da SENEC [min 1000, max 100000]. Predefinito = 5000.",
    "es": "Aquí define el tiempo de espera de la solicitud al sondear desde SENEC [min 1000, max 100000]. Por defecto = 5000.",
    "pl": "Tutaj definiujesz limit czasu żądania podczas odpytywania z SENEC [min 1000, max 100000]. Domyślnie = 5000.",
    "zh-cn": "在此定义从SENEC进行轮询时的请求超时[最小1000，最大100000]。默认值= 5000"
  }
};
